<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");
set_time_limit(0);
ini_set('memory_limit', '512M');
date_default_timezone_set('Asia/Jakarta');

// PHP 7 Compatibility Polyfills
if (!function_exists('str_contains')) {
    function str_contains($haystack, $needle) {
        return $needle === '' || mb_strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_starts_with')) {
    function str_starts_with($haystack, $needle) {
        return (string)$needle !== '' && strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with($haystack, $needle) {
        return $needle === '' || $needle === substr($haystack, -strlen($needle));
    }
}

// Simple .env parser
$envFile = __DIR__ . '/.env';
$env = file_exists($envFile) ? parse_ini_file($envFile) : [];
$host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
$db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : '';
$port = !empty($env['PORT']) ? $env['PORT'] : '3306';

$charset = 'utf8mb4';
$dsn = "mysql:host=$host;port=$port;dbname=$db;charset=$charset";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => true,
];

try {
    $pdo = new PDO($dsn, $user, $pass, $options);
} catch (\PDOException $e) {
    http_response_code(500);
    echo json_encode(["error" => "Koneksi database gagal: " . $e->getMessage()]);
    exit;
}

$action = $_GET['action'] ?? '';
$periode = $_GET['periode'] ?? '202607';

$year = intval(substr($periode, 0, 4));
$month = intval(substr($periode, 4, 2)) + 1;
if ($month > 12) {
    $month = 1;
    $year++;
}
$tanggalLike = sprintf("%04d-%02d", $year, $month);

if ($action === 'beli' || $action === 'batal') {
    try {
        // Buat tabel eliminasi in-memory untuk optimasi performa tinggi (mengatasi database jutaan baris)
        $pdo->exec("
            CREATE TEMPORARY TABLE IF NOT EXISTS tmp_eliminasi (
                no_pdam VARCHAR(10) CHARACTER SET utf8 COLLATE utf8_general_ci PRIMARY KEY,
                alasan VARCHAR(20)
            ) ENGINE=MEMORY;
            TRUNCATE TABLE tmp_eliminasi;
        ");

        // 1a. Tunggakan Reguler / Non-YKK (IS_YKK = 0): Semua yang belum lunas LANGSUNG DIELIMINASI
        $pdo->exec("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Tunggakan' 
            FROM spd_tunggak c USE INDEX(LUNAS)
            WHERE c.IS_DELETE = 0 
              AND c.IS_YKK = 0 
              AND c.LUNAS = 0 
              AND (c.PH IS NULL OR c.PH != 'P');
        ");

        // 1b. Tunggakan YKK (IS_YKK = 1): Maksimal 3 bulan ditoleransi (hanya > 3 bulan yang dieliminasi)
        $pdo->exec("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Tunggakan YKK >3 Bln' 
            FROM spd_tunggak c USE INDEX(LUNAS)
            WHERE c.IS_DELETE = 0 
              AND c.IS_YKK = 1 
              AND c.LUNAS = 0
            GROUP BY no_pdam
            HAVING COUNT(*) > 3;
        ");

        // 1c. Tunggakan YKK dengan Status Penghapusan (PH = 'P')
        $pdo->exec("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Tunggakan PH' 
            FROM spd_tunggak c USE INDEX(IS_YKK)
            WHERE c.IS_DELETE = 0 
              AND c.IS_YKK = 1 
              AND c.PH = 'P';
        ");

        // 2. Data Penertiban (spd_bon)
        $stmtBon = $pdo->prepare("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Penertiban' FROM spd_bon d 
            WHERE d.TANGGAL LIKE CONCAT(:tgl, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0';
        ");
        $stmtBon->execute(['tgl' => $tanggalLike]);

        // 3. Data Realisasi (spd_realmohon)
        $stmtReal = $pdo->prepare("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Realisasi' FROM spd_realmohon e 
            WHERE e.TANGGAL LIKE CONCAT(:tgl, '%') AND e.STPLYN_ID LIKE 't%';
        ");
        $stmtReal->execute(['tgl' => $tanggalLike]);

        // 4. Data Subsidi (spd_rekening periode terpilih)
        $stmtSub = $pdo->prepare("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Subsidi' FROM spd_rekening f 
            WHERE f.PERIODE = :periode AND f.subsidi != 0 AND f.FLAG = '0';
        ");
        $stmtSub->execute(['periode' => $periode]);

        if ($action === 'beli') {
            $query = "
                SELECT 
                    a.NO_PDAM, 
                    b.NAMA, 
                    a.PERIODE, 
                    a.LOKBAY_ID, 
                    a.STGOL_ID, 
                    a.RK, 
                    a.NON_AIR
                FROM spd_rekening a 
                JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                LEFT JOIN tmp_eliminasi x ON x.no_pdam = a.no_pdam
                WHERE 
                    a.PERIODE = :periode 
                    AND a.STATUS = 'a' 
                    AND a.FLAG = '0' 
                    AND a.IS_TUTUPMETER = 1 
                    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
                    AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
                    AND b.nama NOT LIKE '%rumdis%' 
                    AND b.nama NOT LIKE '%rumdin%' 
                    AND b.nama NOT LIKE '%rusus%'
                    AND x.no_pdam IS NULL
            ";
            $stmt = $pdo->prepare($query);
            $stmt->execute(['periode' => $periode]);
            $data = $stmt->fetchAll();
            echo json_encode($data);
        } else {
            $query = "
                SELECT 
                    a.NO_PDAM, 
                    b.NAMA, 
                    a.PERIODE, 
                    a.LOKBAY_ID, 
                    a.STGOL_ID, 
                    a.RK, 
                    a.NON_AIR,
                    CASE
                        WHEN a.STGOL_ID IN ('IB', 'IIB1', 'IIB3', 'IA', 'IIB2', 'IB3', 'IB2', 'IB1', 'IIB4') THEN CONCAT('Golongan ', a.STGOL_ID)
                        WHEN a.STATUS != 'a' THEN CONCAT('Status ', UPPER(a.STATUS))
                        WHEN a.IS_TUTUPMETER != 1 THEN 'Bukan Tutup Meter'
                        WHEN LOWER(b.NAMA) LIKE '%rumdis%' THEN 'Rumdis'
                        WHEN LOWER(b.NAMA) LIKE '%rumdin%' THEN 'Rumdin'
                        WHEN LOWER(b.NAMA) LIKE '%rusus%' THEN 'Rusus'
                        WHEN x.alasan IS NOT NULL THEN x.alasan
                        ELSE 'Lainnya'
                    END AS ALASAN
                FROM spd_rekening a 
                JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                LEFT JOIN tmp_eliminasi x ON x.no_pdam = a.no_pdam
                WHERE 
                    a.PERIODE = :periode 
                    AND a.STATUS != 'l' 
                    AND a.FLAG = '0' 
                    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
                    AND (
                        a.STGOL_ID IN ('IB', 'IIB1', 'IIB3', 'IA', 'IIB2', 'IB3', 'IB2', 'IB1', 'IIB4')
                        OR (
                            a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
                            AND (
                                a.STATUS != 'a'
                                OR a.IS_TUTUPMETER != 1
                                OR (b.nama LIKE '%rumdis%' OR b.nama LIKE '%rumdin%' OR b.nama LIKE '%rusus%')
                                OR x.no_pdam IS NOT NULL
                            )
                        )
                    )
            ";
            $stmt = $pdo->prepare($query);
            $stmt->execute(['periode' => $periode]);
            $data = $stmt->fetchAll();
            echo json_encode($data);
        }
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'dibeli') {
    try {
        $tanggal = $_GET['tanggal'] ?? '';
        $whereClause = "a.IS_YKK = 1 AND a.IS_DELETE = '0'";
        $params = [];

        if (!empty($tanggal)) {
            $whereClause .= " AND a.TANGGAL = :tanggal";
            $params['tanggal'] = $tanggal;
        } else {
            $whereClause .= " AND a.REKENING_BULAN = :periode";
            $params['periode'] = $periode;
        }

        $query = "
            SELECT 
                a.NO_PDAM, 
                b.NAMA, 
                a.REKENING_BULAN AS PERIODE, 
                a.TANGGAL AS TGL_BAYAR,
                a.LOKBAY_ID, 
                a.STGOL_ID, 
                a.HARGA AS RK, 
                a.NON_AIR,
                COALESCE(a.MATERAI, 0) AS MATERAI,
                (a.HARGA + a.NON_AIR + COALESCE(a.MATERAI, 0)) AS TAGIHAN,
                COALESCE(t.DENDA, 0) AS DENDA_YKK,
                (a.HARGA + a.NON_AIR + COALESCE(a.MATERAI, 0) + COALESCE(t.DENDA, 0)) AS TOTAL_BAYAR
            FROM spd_tagrek a 
            JOIN spd_stlgn b ON b.ID = a.STLGN_ID
            LEFT JOIN (
                SELECT NO_PDAM, REKENING_BULAN, MAX(DENDA) AS DENDA
                FROM spd_tunggak 
                WHERE IS_YKK = 1 AND IS_DELETE = '0'
                GROUP BY NO_PDAM, REKENING_BULAN
            ) t ON t.NO_PDAM = a.NO_PDAM 
                AND t.REKENING_BULAN = CONCAT(LEFT(a.REKENING_BULAN, 4), '-', SUBSTRING(a.REKENING_BULAN, 5, 2), '-20')
            WHERE $whereClause
            ORDER BY a.NO_PDAM ASC
        ";
        $stmt = $pdo->prepare($query);
        $stmt->execute($params);
        $data = $stmt->fetchAll();
        echo json_encode($data);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'get_config') {
    try {
        // Auto-cleanup stale schedules (RUNNING > 30 mins or PENDING > 60 mins past execution time)
        $pdo->exec("
            UPDATE ykk_config 
            SET status = 'FAILED', pesan_terakhir = 'Jadwal kedaluwarsa / Timeout'
            WHERE status = 'RUNNING' AND TIMESTAMPDIFF(MINUTE, COALESCE(waktu_eksekusi, jadwal_eksekusi), NOW()) > 30
        ");
        $pdo->exec("
            UPDATE ykk_config 
            SET status = 'FAILED', pesan_terakhir = 'Jadwal terlewati tanpa dieksekusi'
            WHERE status = 'PENDING' AND TIMESTAMPDIFF(MINUTE, jadwal_eksekusi, NOW()) > 60
        ");

        $stmt = $pdo->query("SELECT * FROM ykk_config ORDER BY id DESC LIMIT 10");
        $configs = $stmt->fetchAll();

        // Deteksi periode aktif dari spd_tutuptagihan
        $tutupTagihan = $pdo->query("SELECT PERIODE FROM spd_tutuptagihan WHERE IS_TUTUP = 0 LIMIT 1")->fetch();
        $periodeAktif = $tutupTagihan['PERIODE'] ?? date('Ym');
        $tahun = substr($periodeAktif, 0, 4);
        $bulan = substr($periodeAktif, 4, 2);
        $targetEksekusi = date('Ym', strtotime("$tahun-$bulan-01 -1 months"));

        echo json_encode([
            "status" => "success", 
            "data" => $configs,
            "periode_aktif_db" => $periodeAktif,
            "target_periode_eksekusi" => $targetEksekusi,
            "server_time" => date('Y-m-d H:i:s')
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'reset_pipeline_status') {
    try {
        require_once __DIR__ . '/pipeline_runner.php';
        initPipelineLogTable($pdo);

        // 1. Mark any active RUNNING or PENDING schedules as CANCELLED
        $pdo->exec("
            UPDATE ykk_config 
            SET status = 'CANCELLED', pesan_terakhir = 'Direset ke Standby oleh Operator'
            WHERE status IN ('PENDING', 'RUNNING')
        ");

        // 2. Mark any active RUNNING pipeline logs as FAILED / CANCELLED
        $pdo->exec("
            UPDATE pipeline_log 
            SET status = 'FAILED', pesan = 'Direset ke Standby oleh Operator', waktu_selesai = NOW()
            WHERE status = 'RUNNING'
        ");

        // 3. Ensure offline mode is safely turned back on (pdam.info.OFFLINE = '1') so system is in normal standby
        try {
            $pdo->exec("UPDATE pdam.info SET OFFLINE = '1'");
        } catch (Exception $e) {
            // Ignore if table/field doesn't exist
        }

        echo json_encode([
            "status" => "success",
            "message" => "Status alur eksekusi dan antrean jadwal berhasil di-reset ke Standby."
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'check_cron') {
    try {
        require_once __DIR__ . '/pipeline_runner.php';
        initPipelineLogTable($pdo);

        // Cari jadwal PENDING yang jatuh tempo (jadwal_eksekusi <= NOW())
        $stmt = $pdo->query("
            SELECT * FROM ykk_config 
            WHERE status = 'PENDING' AND jadwal_eksekusi <= NOW() 
            ORDER BY jadwal_eksekusi ASC 
            LIMIT 1
        ");
        $config = $stmt->fetch();
        if ($config) {
            $pdo->prepare("UPDATE ykk_config SET status = 'RUNNING', waktu_eksekusi = NOW() WHERE id = :id")->execute(['id' => $config['id']]);
            
            // Eksekusi Full Master Pipeline (6-Tahapan)
            $res = executeMasterPipeline([
                'executed_by' => 'AUTO_SCHEDULE_CRON',
                'budget' => floatval($config['budget_plafon']),
                'user_id' => intval($config['user_id_input']) ?: 1
            ]);

            if ($res['success']) {
                $pdo->prepare("UPDATE ykk_config SET status = 'SUCCESS', pesan_terakhir = 'Master Pipeline Sukses' WHERE id = :id")->execute(['id' => $config['id']]);
            } else {
                $pdo->prepare("UPDATE ykk_config SET status = 'FAILED', pesan_terakhir = :pesan WHERE id = :id")->execute([
                    'id' => $config['id'],
                    'pesan' => 'Pipeline Gagal: ' . ($res['error'] ?? 'Unknown')
                ]);
            }

            echo json_encode([
                "status" => "executed",
                "message" => "Master Pipeline terjadwal berhasil dieksekusi!",
                "data" => $res,
                "config" => $config
            ]);
        } else {
            echo json_encode(["status" => "standby", "message" => "Tidak ada jadwal PENDING yang jatuh tempo."]);
        }
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'save_config') {
    try {
        $input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
        $periodeIn = $input['periode'] ?? $periode;
        $budgetIn = floatval($input['budget_plafon'] ?? 0);
        $jadwalIn = $input['jadwal_eksekusi'] ?? null;
        $userId = intval($input['user_id'] ?? 1);

        if (!$jadwalIn) {
            // Default tanggal 21 bulan berikutnya pukul 00:05:00
            $pYear = intval(substr($periodeIn, 0, 4));
            $pMonth = intval(substr($periodeIn, 4, 2)) + 1;
            if ($pMonth > 12) {
                $pMonth = 1;
                $pYear++;
            }
            $jadwalIn = sprintf("%04d-%02d-21 00:05:00", $pYear, $pMonth);
        }

        $stmt = $pdo->prepare("
            INSERT INTO ykk_config (periode, budget_plafon, jadwal_eksekusi, status, user_id_input, waktu_input)
            VALUES (:periode, :budget, :jadwal, 'PENDING', :user_id, NOW())
            ON DUPLICATE KEY UPDATE 
                budget_plafon = :budget_up,
                jadwal_eksekusi = :jadwal_up,
                status = 'PENDING',
                user_id_input = :user_id_up,
                waktu_input = NOW(),
                pesan_terakhir = NULL
        ");
        $stmt->execute([
            'periode' => $periodeIn,
            'budget' => $budgetIn,
            'jadwal' => $jadwalIn,
            'user_id' => $userId,
            'budget_up' => $budgetIn,
            'jadwal_up' => $jadwalIn,
            'user_id_up' => $userId
        ]);

        echo json_encode([
            "status" => "success", 
            "message" => "Jadwal ($jadwalIn) dan plafon budget untuk periode $periodeIn berhasil disimpan!"
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'get_logs') {
    try {
        $stmt = $pdo->query("SELECT * FROM ykk_log_eksekusi ORDER BY id DESC LIMIT 50");
        $logs = $stmt->fetchAll();
        echo json_encode(["status" => "success", "data" => $logs]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'run_simulation') {
    try {
        $budgetIn = floatval($_GET['budget'] ?? 0);
        $stmt = $pdo->prepare("CALL sp_eksekusi_beli_ykk(:periode, :budget, 1, 1, 'WEB_SIMULASI')");
        $stmt->execute(['periode' => $periode, 'budget' => $budgetIn]);
        $res = $stmt->fetch();
        echo json_encode(["status" => "success", "data" => $res]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'run_execute') {
    try {
        $input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
        $periodeIn = $input['periode'] ?? $periode;
        $budgetIn = floatval($input['budget_plafon'] ?? 0);
        $userId = intval($input['user_id'] ?? 1);

        $stmt = $pdo->prepare("CALL sp_eksekusi_beli_ykk(:periode, :budget, :user_id, 0, 'WEB_MANUAL')");
        $stmt->execute([
            'periode' => $periodeIn,
            'budget' => $budgetIn,
            'user_id' => $userId
        ]);
        $res = $stmt->fetch();
        echo json_encode(["status" => "success", "data" => $res]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'get_backups') {
    try {
        $backupDir = __DIR__ . '/backups';
        $files = [];
        $totalBytes = 0;
        $retentionDays = 14;

        if (is_dir($backupDir)) {
            $rawFiles = array_unique(array_merge(
                glob("{$backupDir}/*.sql.gz") ?: [],
                glob("{$backupDir}/*.sql") ?: [],
                glob("{$backupDir}/*.gz") ?: []
            ));
            if ($rawFiles) {
                // Sort newest first
                usort($rawFiles, function($a, $b) {
                    return filemtime($b) - filemtime($a);
                });

                $bulanIndo = [
                    '01' => 'Januari', '02' => 'Februari', '03' => 'Maret', '04' => 'April',
                    '05' => 'Mei', '06' => 'Juni', '07' => 'Juli', '08' => 'Agustus',
                    '09' => 'September', '10' => 'Oktober', '11' => 'November', '12' => 'Desember'
                ];

                $now = time();
                foreach ($rawFiles as $filePath) {
                    $bytes = filesize($filePath);
                    $mtime = filemtime($filePath);
                    $totalBytes += $bytes;
                    $ageDays = floor(($now - $mtime) / (60 * 60 * 24));
                    $fname = basename($filePath);

                    // Ekstraksi tipe closing dan label
                    $closingType = 'MANUAL';
                    $typeBadge = 'Manual Snapshot';
                    $customNote = '';

                    if (str_contains($fname, 'CLOSING_TAGIHAN')) {
                        $closingType = 'CLOSING_TAGIHAN';
                        $typeBadge = 'Closing Tagihan (Tgl 21)';
                    } elseif (str_contains($fname, 'CLOSING_REKENING')) {
                        $closingType = 'CLOSING_REKENING';
                        $typeBadge = 'Closing Rekening (Tgl 1)';
                    } else {
                        $closingType = 'MANUAL';
                        $typeBadge = 'Manual Snapshot';
                    }

                    // Ekstraksi label kustom (misal: simpadu_MANUAL_sebelum_tarif_p202609_...)
                    if (preg_match('/(?:MANUAL|CLOSING_TAGIHAN|CLOSING_REKENING)_([a-zA-Z0-9_-]+)_p\d{6}_/', $fname, $mNote)) {
                        $customNote = str_replace('_', ' ', $mNote[1]);
                    }

                    // Ekstraksi periode database dari nama berkas atau tanggal
                    $filePeriode = '';
                    if (preg_match('/_p(\d{6})_/', $fname, $mP)) {
                        $filePeriode = $mP[1];
                    } else {
                        // Perkiraan periode dari tanggal pembuatan berkas (bulan lalu)
                        $filePeriode = date('Ym', strtotime(date('Y-m-01', $mtime) . ' -1 month'));
                    }

                    $pYear = substr($filePeriode, 0, 4);
                    $pMonth = substr($filePeriode, 4, 2);
                    $monthName = $bulanIndo[$pMonth] ?? $pMonth;
                    $periodeLabel = "{$filePeriode} ({$monthName} {$pYear})";

                    $files[] = [
                        "filename" => $fname,
                        "type" => $closingType,
                        "type_label" => $typeBadge,
                        "custom_note" => $customNote,
                        "periode" => $filePeriode,
                        "periode_label" => $periodeLabel,
                        "size_bytes" => $bytes,
                        "size_formatted" => round($bytes / 1024 / 1024, 2) . ' MB',
                        "created_at" => date('Y-m-d H:i:s', $mtime),
                        "age_days" => $ageDays,
                        "retention_status" => ($ageDays < $retentionDays) ? 'Aktif' : 'Kedaluwarsa'
                    ];
                }
            }
        }

        $logContent = '';
        $logFile = "{$backupDir}/backup.log";
        if (file_exists($logFile)) {
            $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            $recentLines = array_slice($lines, -50);
            $logContent = implode("\n", $recentLines);
        }

        echo json_encode([
            "status" => "success",
            "data" => [
                "files" => $files,
                "total_files" => count($files),
                "total_size" => round($totalBytes / 1024 / 1024, 2) . ' MB',
                "last_backup" => !empty($files) ? $files[0]['created_at'] : '-',
                "retention_days" => $retentionDays,
                "log" => $logContent,
                "server_time" => date('Y-m-d H:i:s')
            ]
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'run_backup') {
    try {
        $input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
        $type = $input['type'] ?? ($_GET['type'] ?? 'MANUAL');
        $label = $input['label'] ?? ($_GET['label'] ?? '');

        $possiblePhp = ['/usr/bin/php', '/usr/local/bin/php', (defined('PHP_BINARY') ? PHP_BINARY : '')];
        $phpBinary = 'php';
        foreach ($possiblePhp as $p) {
            if (!empty($p) && is_executable($p) && !str_contains($p, 'fpm')) {
                $phpBinary = $p;
                break;
            }
        }

        $backupScript = __DIR__ . '/backup_simpadu.php';
        $cmd = sprintf(
            "nohup %s %s %s %s > /dev/null 2>&1 &",
            escapeshellcmd($phpBinary),
            escapeshellarg($backupScript),
            escapeshellarg($type),
            escapeshellarg($label)
        );
        exec($cmd);

        echo json_encode([
            "status" => "success",
            "message" => "Proses pencadangan database 'simpadu' ($type) telah dimulai di latar belakang.",
            "is_async" => true
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'get_backup_status') {
    try {
        $activeQuery = null;
        $activeTable = null;
        $querySnippet = null;

        // Cek SHOW FULL PROCESSLIST di server MySQL untuk query mysqldump / backup saja (hindari query restore INSERT/CREATE)
        $stmt = $pdo->query("SHOW FULL PROCESSLIST");
        $processes = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($processes as $p) {
            $info = trim($p['Info'] ?? '');
            if (!empty($info) && stripos($info, 'SHOW FULL PROCESSLIST') === false && stripos($info, 'ykk_config') === false) {
                // Hanya tangkap query pembacaan mysqldump (SQL_NO_CACHE / SELECT / LOCK TABLES / SHOW CREATE TABLE)
                // Abaikan query penulisan restore (INSERT INTO, CREATE TABLE, ALTER TABLE, DROP TABLE)
                $isRestoreQuery = stripos($info, 'INSERT INTO') !== false || stripos($info, 'CREATE TABLE') !== false || stripos($info, 'DROP TABLE') !== false || stripos($info, 'ALTER TABLE') !== false;
                $isDumpQuery = stripos($info, 'SQL_NO_CACHE') !== false || stripos($info, 'LOCK TABLES') !== false || stripos($info, 'SHOW CREATE TABLE') !== false || (stripos($info, 'SELECT') !== false && stripos($info, 'SELECT /*!') !== false);

                if ($isDumpQuery && !$isRestoreQuery) {
                    if (preg_match('/(?:FROM|TABLE)\s+[`\'"]?([a-zA-Z0-9_]+)[`\'"]?/i', $info, $matches)) {
                        $activeTable = $matches[1];
                    }
                    $activeQuery = $info;
                    $querySnippet = substr($info, 0, 140) . (strlen($info) > 140 ? '...' : '');
                    break;
                }
            }
        }

        // Parsing detail dari backup.log
        $logFile = __DIR__ . '/backups/backup.log';
        $lastLog = '';
        $startTime = '';
        $isFinished = false;
        $finishDuration = 0;

        if (file_exists($logFile)) {
            $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (!empty($lines)) {
                $lastLog = end($lines);
                for ($i = count($lines) - 1; $i >= 0; $i--) {
                    $l = $lines[$i];
                    if (str_contains($l, 'Memulai proses backup database')) {
                        if (preg_match('/^\[(.*?)\]/', $l, $m)) {
                            $startTime = $m[1];
                        }
                        break;
                    }
                    if (str_contains($l, 'SUCCESS: Backup database berhasil')) {
                        $isFinished = true;
                    }
                }
            }
        }

        // Cek file backup aktif & ukuran
        $backupDir = __DIR__ . '/backups';
        $currentSizeMb = 0;
        $refSizeMb = 492.0;
        $pct = 0;
        $activeFilename = '';
        $isWriting = false;

        if (is_dir($backupDir)) {
            $files = glob($backupDir . '/*.sql.gz');
            if ($files) {
                usort($files, function($a, $b) { return filemtime($b) - filemtime($a); });
                $latestFile = $files[0];
                $activeFilename = basename($latestFile);
                $mtime = filemtime($latestFile);
                $bytes = filesize($latestFile);
                $currentSizeMb = round($bytes / (1024 * 1024), 2);
                $isWriting = (time() - $mtime) < 45;

                foreach ($files as $f) {
                    $sz = round(filesize($f) / (1024 * 1024), 2);
                    if ($f !== $latestFile && $sz > 50) {
                        $refSizeMb = $sz;
                        break;
                    }
                }
                $pct = min(100, round(($currentSizeMb / $refSizeMb) * 100));
            }
        }

        // Cek apakah proses backup di tingkat OS sedang berjalan aktif
        $backupPidFile = $backupDir . '/.backup.pid';
        $isBackupProcessAlive = false;
        if (file_exists($backupPidFile)) {
            $pid = intval(trim(file_get_contents($backupPidFile)));
            if ($pid > 0 && function_exists('posix_kill')) {
                $isBackupProcessAlive = @posix_kill($pid, 0);
            }
            if (!$isBackupProcessAlive && !$isWriting) {
                @unlink($backupPidFile);
            }
        }

        // Cek log apakah backup sudah selesai
        if ($isFinished || (!$isBackupProcessAlive && !$isWriting && $currentSizeMb > 10)) {
            $isReallyActive = false;
        } else {
            $isReallyActive = ($isBackupProcessAlive || $isWriting) && (!empty($activeFilename) || !empty($startTime));
        }

        $elapsedSeconds = $startTime ? (time() - strtotime($startTime)) : 0;

        echo json_encode([
            "status" => "success",
            "is_active" => $isReallyActive,
            "is_finished" => $isFinished,
            "filename" => $activeFilename,
            "start_time" => $startTime,
            "elapsed_seconds" => $elapsedSeconds,
            "current_size_mb" => $currentSizeMb,
            "estimated_total_mb" => $refSizeMb,
            "percent" => $pct,
            "active_table" => $isReallyActive ? $activeTable : null,
            "query_snippet" => $isReallyActive ? $querySnippet : null,
            "last_log" => $lastLog,
            "timestamp" => date('H:i:s')
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'download_backup') {
    $file = basename($_GET['file'] ?? '');
    $filePath = __DIR__ . '/backups/' . $file;
    if (!empty($file) && file_exists($filePath) && str_ends_with($file, '.sql.gz')) {
        header('Content-Description: File Transfer');
        header('Content-Type: application/gzip');
        header('Content-Disposition: attachment; filename="' . $file . '"');
        header('Expires: 0');
        header('Cache-Control: must-revalidate');
        header('Pragma: public');
        header('Content-Length: ' . filesize($filePath));
        readfile($filePath);
        exit;
    } else {
        http_response_code(404);
        echo json_encode(["error" => "File backup tidak ditemukan atau tidak valid."]);
    }
} elseif ($action === 'run_restore') {
    try {
        $input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
        $file = basename($input['file'] ?? '');
        $targetDb = trim($input['target_db'] ?? 'simpadu');
        $safetyBackup = isset($input['safety_backup']) ? (bool)$input['safety_backup'] : true;
        $confirmText = trim($input['confirm_text'] ?? '');

        if (strtoupper($confirmText) !== 'RESTORE') {
            http_response_code(400);
            echo json_encode(["status" => "error", "message" => "Konfirmasi keamanan gagal. Anda harus mengetik kata RESTORE persis."]);
            exit;
        }

        if (empty($file) || !file_exists(__DIR__ . '/backups/' . $file)) {
            http_response_code(404);
            echo json_encode(["status" => "error", "message" => "Berkas cadangan tidak ditemukan."]);
            exit;
        }

        // Jalankan restore_simpadu.php secara non-blocking di latar belakang
        $restoreScript = __DIR__ . '/restore_simpadu.php';
        $safetyFlag = $safetyBackup ? '1' : '0';
        $cmd = sprintf(
            "nohup php %s %s %s %s > /dev/null 2>&1 &",
            escapeshellarg($restoreScript),
            escapeshellarg($file),
            escapeshellarg($targetDb),
            escapeshellarg($safetyFlag)
        );
        exec($cmd);

        echo json_encode([
            "status" => "success",
            "message" => "Pemulihan database '$targetDb' dari berkas $file telah dimulai di latar belakang.",
            "is_async" => true
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'get_restore_status') {
    try {
        $activeQuery = null;
        $activeTable = null;
        $querySnippet = null;

        // Cek SHOW FULL PROCESSLIST di server MySQL
        $stmt = $pdo->query("SHOW FULL PROCESSLIST");
        $processes = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($processes as $p) {
            $info = trim($p['Info'] ?? '');
            if (!empty($info) && stripos($info, 'SHOW FULL PROCESSLIST') === false && stripos($info, 'ykk_config') === false) {
                if (stripos($info, 'INSERT INTO') !== false || stripos($info, 'CREATE TABLE') !== false || stripos($info, 'DROP TABLE') !== false || stripos($info, 'ALTER TABLE') !== false || stripos($info, 'LOAD DATA') !== false) {
                    if (preg_match('/(?:INSERT\s+INTO|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+[`\'"]?([a-zA-Z0-9_]+)[`\'"]?/i', $info, $matches)) {
                        $activeTable = $matches[1];
                    }
                    $activeQuery = $info;
                    $querySnippet = substr($info, 0, 140) . (strlen($info) > 140 ? '...' : '');
                    break;
                }
            }
        }

        // Parsing detail dari restore.log
        $logFile = __DIR__ . '/backups/restore.log';
        $lastLog = '';
        $sourceFile = '';
        $targetDbName = 'simpadu';
        $startTime = '';
        $hasSafetySnapshot = false;
        $isFinished = false;
        $finishDuration = 0;

        if (file_exists($logFile)) {
            $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (!empty($lines)) {
                $lastLog = end($lines);
                
                // Cari blok eksekusi terakhir
                for ($i = count($lines) - 1; $i >= 0; $i--) {
                    $l = $lines[$i];
                    if (str_contains($l, 'MEMULAI PROSES PEMULIHAN')) {
                        if (preg_match('/^\[(.*?)\]/', $l, $m)) {
                            $startTime = $m[1];
                        }
                        break;
                    }
                    if (str_contains($l, 'Berkas Sumber:') && preg_match('/Berkas Sumber:\s*([^\s]+)/', $l, $m)) {
                        $sourceFile = $m[1];
                    }
                    if (str_contains($l, 'Target Database:') && preg_match('/Target Database:\s*([^\s]+)/', $l, $m)) {
                        $targetDbName = $m[1];
                    }
                    if (str_contains($l, 'Safety snapshot berhasil')) {
                        $hasSafetySnapshot = true;
                    }
                    if (str_contains($l, 'SUCCESS: Pemulihan database') && preg_match('/dalam\s+([\d\.]+)\s+detik/', $l, $m)) {
                        $isFinished = true;
                        $finishDuration = floatval($m[1]);
                    }
                }
            }
        }

        // Cek status proses restore pada level sistem operasi (OS)
        $restorePidFile = __DIR__ . '/backups/.restore.pid';
        $isRestoreProcessAlive = false;
        if (file_exists($restorePidFile)) {
            $pid = intval(trim(file_get_contents($restorePidFile)));
            if ($pid > 0 && $pid !== getmypid()) {
                if (file_exists("/proc/$pid")) {
                    $isRestoreProcessAlive = true;
                } elseif (function_exists('posix_kill')) {
                    $isRestoreProcessAlive = @posix_kill($pid, 0);
                } else {
                    exec("ps -p $pid -o pid= 2>/dev/null", $psOut, $psCode);
                    $isRestoreProcessAlive = ($psCode === 0 && !empty($psOut) && intval(trim($psOut[0])) === $pid);
                }
            }
            if (!$isRestoreProcessAlive) {
                @unlink($restorePidFile);
            }
        }
        if (!$isRestoreProcessAlive) {
            exec("ps aux 2>/dev/null | grep -E '[r]estore_simpadu.php|[g]unzip.*mysql' | grep -v 'grep'", $pgOut, $pgCode);
            $isRestoreProcessAlive = ($pgCode === 0 && !empty($pgOut));
        }

        $elapsedSeconds = $startTime ? (time() - strtotime($startTime)) : 0;
        
        // Hitung estimasi persentase progres dinamis impor database (0% - 100%) dan jumlah baris data
        $dynamicPercent = 0;
        $importedTablesCount = 0;
        $totalEstimatedTables = 89;
        $importedRowsCount = 0;
        $totalEstimatedRows = 23057050; // Total estimasi baris database SIMPADU utuh (23.05M Baris)

        try {
            $stmtTb = $pdo->prepare("SELECT COUNT(*) AS total_tables, SUM(TABLE_ROWS) AS total_rows FROM information_schema.TABLES WHERE TABLE_SCHEMA = :targetDb");
            $stmtTb->execute(['targetDb' => $targetDbName]);
            $tbRow = $stmtTb->fetch(PDO::FETCH_ASSOC);
            $importedTablesCount = intval($tbRow['total_tables'] ?? 0);
            $importedRowsCount = intval($tbRow['total_rows'] ?? 0);
        } catch (Exception $e) {
            $importedTablesCount = 0;
            $importedRowsCount = 0;
        }

        $effectiveTarget = max($totalEstimatedRows, $importedRowsCount);
        $rowsProgressPct = $effectiveTarget > 0 ? min(99, round(($importedRowsCount / $effectiveTarget) * 100, 1)) : 0;
        $rowsFormatted = number_format($importedRowsCount, 0, ',', '.') . ' / ' . number_format($effectiveTarget, 0, ',', '.') . ' Baris';

        if (!$hasSafetySnapshot && empty($activeQuery)) {
            // Masih dalam Tahap 1: Safety Snapshot (0% - 25%)
            $dynamicPercent = min(25, max(5, round(($elapsedSeconds / 180) * 25)));
            $rowsFormatted = 'Membuat Safety Snapshot...';
            $rowsProgressPct = $dynamicPercent;
        } elseif ($importedRowsCount > 0 && ($hasSafetySnapshot || !empty($activeQuery))) {
            // Tahap 3: Impor Data MySQL (25% - 98%)
            $dynamicPercent = min(98, max(30, round(($importedRowsCount / $effectiveTarget) * 98)));
        } elseif ($importedTablesCount > 0) {
            $tableProgress = min(70, round(($importedTablesCount / $totalEstimatedTables) * 70));
            $dynamicPercent = min(98, 25 + $tableProgress);
            if ($dynamicPercent < 30) $dynamicPercent = 30;
        } elseif ($hasSafetySnapshot) {
            $dynamicPercent = 25;
            $rowsFormatted = 'Dekompresi arsip .sql.gz...';
        } else {
            $dynamicPercent = min(25, max(5, round(($elapsedSeconds / 300) * 25)));
        }

        // Jika proses OS masih hidup atau ada query aktif, maka proses berjalan
        if ($isRestoreProcessAlive) {
            $isReallyActive = true;
            $isFinished = false;
        } elseif (!empty($activeQuery)) {
            $isReallyActive = true;
            $isFinished = false;
        } else {
            $isReallyActive = false;
            // Jika tidak ada proses aktif lagi dan tabel sudah terisi penuh (89 tabel)
            if ($importedTablesCount >= 85) {
                $isFinished = true;
                $dynamicPercent = 100;
            }
        }

        echo json_encode([
            "status" => "success",
            "is_active" => $isReallyActive,
            "is_finished" => $isFinished,
            "finish_duration" => $finishDuration,
            "percent" => $dynamicPercent,
            "imported_rows" => $importedRowsCount,
            "total_rows" => $totalEstimatedRows,
            "rows_formatted" => $rowsFormatted,
            "rows_percent" => $rowsProgressPct,
            "imported_tables" => $importedTablesCount,
            "total_tables" => $totalEstimatedTables,
            "source_file" => $sourceFile,
            "target_db" => $targetDbName,
            "start_time" => $startTime,
            "elapsed_seconds" => $elapsedSeconds,
            "has_safety_snapshot" => $hasSafetySnapshot,
            "active_table" => $activeTable,
            "query_snippet" => $querySnippet,
            "last_log" => $lastLog,
            "timestamp" => date('H:i:s')
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'run_pipeline') {
    try {
        require_once __DIR__ . '/pipeline_runner.php';
        $input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
        $budget = isset($input['budget']) ? floatval($input['budget']) : null;
        $userId = intval($input['user_id'] ?? 1);
        $executedBy = $input['executed_by'] ?? 'WEB_DASHBOARD';

        $result = executeMasterPipeline([
            'executed_by' => $executedBy,
            'budget' => $budget,
            'user_id' => $userId
        ]);

        if ($result['success']) {
            echo json_encode([
                "status" => "success",
                "message" => "Master Pipeline berhasil dieksekusi!",
                "data" => $result
            ]);
        } else {
            http_response_code(500);
            echo json_encode([
                "status" => "error",
                "message" => "Master Pipeline gagal: " . ($result['error'] ?? 'Unknown error'),
                "data" => $result
            ]);
        }
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'get_pipeline_logs') {
    try {
        require_once __DIR__ . '/pipeline_runner.php';
        initPipelineLogTable($pdo);

        // Auto-resolve batch pipeline yang menggantung (> 15 menit tanpa aktivitas)
        $pdo->exec("
            UPDATE pipeline_log 
            SET status = 'FAILED', pesan = 'Dihentikan oleh sistem / Timeout', waktu_selesai = NOW()
            WHERE status = 'RUNNING' AND TIMESTAMPDIFF(MINUTE, waktu_mulai, NOW()) > 15
        ");

        $limit = intval($_GET['limit'] ?? 50);
        $stmt = $pdo->prepare("
            SELECT * FROM pipeline_log 
            ORDER BY id DESC 
            LIMIT :limit
        ");
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $logs = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Group by batch_id
        $batches = [];
        $hasActiveBatch = false;
        foreach ($logs as $row) {
            $bId = $row['batch_id'];
            if (!isset($batches[$bId])) {
                $batches[$bId] = [
                    'batch_id' => $bId,
                    'periode' => $row['periode'],
                    'waktu_mulai' => $row['waktu_mulai'],
                    'status' => 'SUCCESS',
                    'steps' => []
                ];
            }
            if ($row['status'] === 'FAILED') {
                $batches[$bId]['status'] = 'FAILED';
            } elseif ($row['status'] === 'RUNNING') {
                $batches[$bId]['status'] = 'RUNNING';
                $hasActiveBatch = true;
            }
            $batches[$bId]['steps'][] = $row;
        }

        // Cek progres realtime pencadangan database (Tahap 1)
        $activeBackup = null;
        if ($hasActiveBatch) {
            $backupDir = __DIR__ . '/backups';
            if (is_dir($backupDir)) {
                $files = glob($backupDir . '/simpadu_*.sql.gz');
                if ($files) {
                    usort($files, function($a, $b) { return filemtime($b) - filemtime($a); });
                    $latestFile = $files[0];
                    $mtime = filemtime($latestFile);
                    $sizeBytes = filesize($latestFile);
                    $sizeMb = round($sizeBytes / (1024 * 1024), 2);
                    
                    $refSizeMb = 492.0;
                    foreach ($files as $f) {
                        $sz = round(filesize($f) / (1024 * 1024), 2);
                        if ($f !== $latestFile && $sz > 50) {
                            $refSizeMb = $sz;
                            break;
                        }
                    }

                    $isWriting = (time() - $mtime) < 30;
                    $pct = min(100, round(($sizeMb / $refSizeMb) * 100));

                    $activeBackup = [
                        'is_writing' => $isWriting,
                        'filename' => basename($latestFile),
                        'current_size_mb' => $sizeMb,
                        'estimated_total_mb' => $refSizeMb,
                        'percent' => $pct,
                        'display_text' => "$sizeMb MB / ~$refSizeMb MB ($pct%)"
                    ];
                }
            }
        }

        // Cek query aktif di MySQL server HANYA jika pipeline aktif berjalan
        $activeQuery = null;
        $activeTable = null;
        $querySnippet = null;

        if ($hasActiveBatch) {
            $stmt = $pdo->query("SHOW FULL PROCESSLIST");
            $processes = $stmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($processes as $p) {
                $info = trim($p['Info'] ?? '');
                if (!empty($info) && stripos($info, 'SHOW FULL PROCESSLIST') === false && stripos($info, 'ykk_config') === false) {
                    if (preg_match('/(?:FROM|TABLE|INTO|UPDATE|CALL)\s+[`\'"]?([a-zA-Z0-9_\.]+)[`\'"]?/i', $info, $matches)) {
                        $activeTable = $matches[1];
                    }
                    $activeQuery = $info;
                    $querySnippet = substr($info, 0, 140) . (strlen($info) > 140 ? '...' : '');
                    break;
                }
            }
        }

        echo json_encode([
            "status" => "success",
            "batches" => array_values($batches),
            "raw_logs" => $logs,
            "active_backup" => $activeBackup,
            "active_table" => $activeTable,
            "query_snippet" => $querySnippet
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'get_server_metrics') {
    try {
        // 1. Storage / Disk
        $diskPath = __DIR__;
        $diskFree = @disk_free_space($diskPath) ?: 0;
        $diskTotal = @disk_total_space($diskPath) ?: 0;
        $diskUsed = $diskTotal - $diskFree;
        $diskPct = $diskTotal > 0 ? round(($diskUsed / $diskTotal) * 100, 1) : 0;
        
        $diskFreeGb = round($diskFree / (1024 * 1024 * 1024), 2);
        $diskTotalGb = round($diskTotal / (1024 * 1024 * 1024), 2);
        $diskUsedGb = round($diskUsed / (1024 * 1024 * 1024), 2);

        // 2. RAM / Memory
        $ramTotal = 0;
        $ramFree = 0;
        $ramAvailable = 0;
        $ramUsed = 0;
        $ramPct = 0;

        if (file_exists('/proc/meminfo')) {
            $meminfo = file_get_contents('/proc/meminfo');
            if (preg_match('/MemTotal:\s+(\d+)\s+kB/i', $meminfo, $m)) $ramTotal = intval($m[1]) * 1024;
            if (preg_match('/MemFree:\s+(\d+)\s+kB/i', $meminfo, $m)) $ramFree = intval($m[1]) * 1024;
            if (preg_match('/MemAvailable:\s+(\d+)\s+kB/i', $meminfo, $m)) {
                $ramAvailable = intval($m[1]) * 1024;
                $ramUsed = $ramTotal - $ramAvailable;
            } else {
                $buffers = 0;
                $cached = 0;
                if (preg_match('/Buffers:\s+(\d+)\s+kB/i', $meminfo, $m)) $buffers = intval($m[1]) * 1024;
                if (preg_match('/Cached:\s+(\d+)\s+kB/i', $meminfo, $m)) $cached = intval($m[1]) * 1024;
                $ramUsed = $ramTotal - ($ramFree + $buffers + $cached);
            }
            if ($ramTotal > 0) $ramPct = round(($ramUsed / $ramTotal) * 100, 1);
        } else {
            // macOS fallback via sysctl / vm_stat
            $totalMem = @shell_exec('sysctl -n hw.memsize 2>/dev/null');
            $ramTotal = $totalMem ? floatval(trim($totalMem)) : (8 * 1024 * 1024 * 1024);
            $ramUsed = round($ramTotal * 0.45);
            $ramPct = 45.0;
        }

        $ramUsedGb = round($ramUsed / (1024 * 1024 * 1024), 2);
        $ramTotalGb = round($ramTotal / (1024 * 1024 * 1024), 2);
        $ramFreeGb = round(($ramTotal - $ramUsed) / (1024 * 1024 * 1024), 2);

        // 3. CPU Load & Cores
        $cpuCores = 1;
        if (file_exists('/proc/cpuinfo')) {
            $cpuinfo = file_get_contents('/proc/cpuinfo');
            $cpuCores = max(1, substr_count($cpuinfo, 'processor'));
        } elseif (function_exists('shell_exec')) {
            $nproc = @shell_exec('nproc 2>/dev/null') ?: @shell_exec('sysctl -n hw.ncpu 2>/dev/null');
            if ($nproc) $cpuCores = max(1, intval(trim($nproc)));
        }

        $loadAvg = function_exists('sys_getloadavg') ? sys_getloadavg() : [0.0, 0.0, 0.0];
        $load1 = round($loadAvg[0] ?? 0, 2);
        $load5 = round($loadAvg[1] ?? 0, 2);
        $load15 = round($loadAvg[2] ?? 0, 2);
        $cpuPct = min(100, round(($load1 / $cpuCores) * 100, 1));

        // 4. Network Traffic (Linux /proc/net/dev)
        $rxBytes = 0;
        $txBytes = 0;
        if (file_exists('/proc/net/dev')) {
            $netLines = file('/proc/net/dev');
            foreach ($netLines as $line) {
                if (str_contains($line, ':') && !str_contains($line, 'lo:')) {
                    $parts = preg_split('/\s+/', trim(substr($line, strpos($line, ':') + 1)));
                    if (count($parts) >= 9) {
                        $rxBytes += floatval($parts[0]);
                        $txBytes += floatval($parts[8]);
                    }
                }
            }
        }
        $rxMb = round($rxBytes / (1024 * 1024), 1);
        $txMb = round($txBytes / (1024 * 1024), 1);

        // 5. Database Stats & Connection
        $dbSizeMb = 0;
        $dbUptime = 0;
        $dbThreads = 0;
        $dbName = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
        $dbHost = !empty($env['DB_HOST']) ? $env['DB_HOST'] : '127.0.0.1';
        $dbPort = !empty($env['DB_PORT']) ? $env['DB_PORT'] : '3306';
        
        $dbHostLabel = $dbHost;
        $dbEnvType = 'Custom';
        if ($dbHost === '192.168.0.10') {
            $dbHostLabel = 'SIMPAM (Development)';
            $dbEnvType = 'Development';
        } elseif ($dbHost === '192.168.8.11') {
            $dbHostLabel = 'SIMPADU (Production)';
            $dbEnvType = 'Production';
        }

        $dbPingMs = 0.0;
        $mysqlVersion = 'Unknown';
        try {
            $tPingStart = microtime(true);
            $pdo->query("SELECT 1");
            $dbPingMs = round((microtime(true) - $tPingStart) * 1000, 2);

            $mysqlVersion = $pdo->getAttribute(PDO::ATTR_SERVER_VERSION);

            $sizeStmt = $pdo->prepare("
                SELECT SUM(data_length + index_length) / 1024 / 1024 AS size_mb 
                FROM information_schema.TABLES 
                WHERE table_schema = :dbname
            ");
            $sizeStmt->execute(['dbname' => $dbName]);
            $dbSizeMb = round(floatval($sizeStmt->fetchColumn() ?: 0), 2);

            $statusStmt = $pdo->query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')");
            $statusRows = $statusStmt->fetchAll(PDO::FETCH_KEY_PAIR);
            $dbUptime = intval($statusRows['Uptime'] ?? 0);
            $dbThreads = intval($statusRows['Threads_connected'] ?? 0);
        } catch (Exception $dbe) {}

        // 6. Active Billing Period & Last Closing Execution
        $activePeriod = date('Ym');
        $activePeriodFormatted = date('F Y');
        try {
            $cfgStmt = $pdo->query("SELECT setting_value FROM ykk_config WHERE setting_key = 'periode_aktif' LIMIT 1");
            $cfgPeriod = $cfgStmt ? $cfgStmt->fetchColumn() : null;
            if ($cfgPeriod && preg_match('/^\d{6}$/', $cfgPeriod)) {
                $activePeriod = $cfgPeriod;
            } else {
                $perStmt = $pdo->query("SELECT MAX(PERIODE) FROM spd_rekening WHERE STATUS = 'a'");
                $maxP = $perStmt ? $perStmt->fetchColumn() : null;
                if ($maxP) $activePeriod = $maxP;
            }
            if (strlen($activePeriod) === 6) {
                $thn = substr($activePeriod, 0, 4);
                $bln = substr($activePeriod, 4, 2);
                $namaBulan = [
                    '01' => 'Januari', '02' => 'Februari', '03' => 'Maret', '04' => 'April',
                    '05' => 'Mei', '06' => 'Juni', '07' => 'Juli', '08' => 'Agustus',
                    '09' => 'September', '10' => 'Oktober', '11' => 'November', '12' => 'Desember'
                ];
                $activePeriodFormatted = ($namaBulan[$bln] ?? $bln) . ' ' . $thn;
            }
        } catch (Exception $e) {}

        // Last Closing Execution Info
        $lastClosing = null;
        try {
            $pipeStmt = $pdo->query("SELECT periode, status, created_at, execution_time_sec FROM pipeline_log ORDER BY id DESC LIMIT 1");
            $lastClosingRow = $pipeStmt ? $pipeStmt->fetch(PDO::FETCH_ASSOC) : null;
            if ($lastClosingRow) {
                $lastClosing = [
                    'periode' => $lastClosingRow['periode'],
                    'status' => $lastClosingRow['status'],
                    'created_at' => $lastClosingRow['created_at'],
                    'duration' => $lastClosingRow['execution_time_sec'] . ' detik'
                ];
            }
        } catch (Exception $e) {}

        // 7. Last Backup File Info
        $lastBackup = null;
        $backupDir = __DIR__ . '/backups';
        if (is_dir($backupDir)) {
            $backupFiles = array_unique(array_merge(
                glob("{$backupDir}/*.sql.gz") ?: [],
                glob("{$backupDir}/*.sql") ?: [],
                glob("{$backupDir}/*.gz") ?: []
            ));
            if (!empty($backupFiles)) {
                usort($backupFiles, function($a, $b) {
                    return filemtime($b) - filemtime($a);
                });
                $newest = $backupFiles[0];
                $mtime = filemtime($newest);
                $sz = filesize($newest);
                $szFmt = $sz >= 1048576 ? round($sz / 1048576, 1) . ' MB' : round($sz / 1024, 1) . ' KB';
                
                $diffHours = round((time() - $mtime) / 3600, 1);
                $timeAgo = $diffHours < 1 ? 'Baru saja' : ($diffHours < 24 ? round($diffHours) . ' jam lalu' : floor($diffHours / 24) . ' hari lalu');

                $lastBackup = [
                    'filename' => basename($newest),
                    'size_formatted' => $szFmt,
                    'datetime' => date('d M Y H:i', $mtime),
                    'time_ago' => $timeAgo,
                    'is_recent' => ($diffHours <= 24)
                ];
            }
        }

        // 8. Pre-Closing Conflict / Health Check
        $duplicateCount = 0;
        try {
            $dupStmt = $pdo->query("
                SELECT COUNT(*) 
                FROM spd_tagrek a 
                INNER JOIN spd_tunggak b 
                   ON a.no_pdam = b.no_pdam 
                  AND a.rekening_bulan = b.rekening_bulan 
                  AND a.is_delete = 0 
                  AND b.is_delete = 0 
                  AND a.lunas = 0 
                  AND b.lunas = 0
            ");
            $duplicateCount = intval($dupStmt ? $dupStmt->fetchColumn() : 0);
        } catch (Exception $e) {}

        echo json_encode([
            "status" => "success",
            "server_time" => date('Y-m-d H:i:s'),
            "server_env" => [
                "php_version" => PHP_VERSION,
                "os" => PHP_OS . ' (' . php_uname('m') . ')',
                "web_server" => $_SERVER['SERVER_SOFTWARE'] ?? 'Apache/Nginx',
                "hostname" => gethostname() ?: 'server'
            ],
            "database" => [
                "host" => $dbHost,
                "port" => $dbPort,
                "name" => $dbName,
                "label" => $dbHostLabel,
                "env_type" => $dbEnvType,
                "version" => $mysqlVersion,
                "size_mb" => $dbSizeMb,
                "size_formatted" => $dbSizeMb > 1024 ? round($dbSizeMb / 1024, 2) . " GB" : $dbSizeMb . " MB",
                "uptime_hours" => round($dbUptime / 3600, 1),
                "threads_connected" => $dbThreads,
                "ping_ms" => $dbPingMs
            ],
            "closing_ops" => [
                "active_period" => $activePeriod,
                "active_period_formatted" => $activePeriodFormatted,
                "duplicate_count" => $duplicateCount,
                "last_backup" => $lastBackup,
                "last_closing" => $lastClosing
            ],
            "disk" => [
                "free_gb" => $diskFreeGb,
                "total_gb" => $diskTotalGb,
                "used_gb" => $diskUsedGb,
                "percent" => $diskPct,
                "free_formatted" => $diskFreeGb . " GB",
                "total_formatted" => $diskTotalGb . " GB",
                "status_color" => $diskPct > 90 ? "danger" : ($diskPct > 75 ? "warning" : "success")
            ],
            "ram" => [
                "used_gb" => $ramUsedGb,
                "total_gb" => $ramTotalGb,
                "free_gb" => $ramFreeGb,
                "percent" => $ramPct,
                "used_formatted" => $ramUsedGb . " GB",
                "total_formatted" => $ramTotalGb . " GB",
                "status_color" => $ramPct > 90 ? "danger" : ($ramPct > 75 ? "warning" : "success")
            ],
            "cpu" => [
                "cores" => $cpuCores,
                "percent" => $cpuPct,
                "load_1m" => $load1,
                "load_5m" => $load5,
                "load_15m" => $load15,
                "status_color" => $cpuPct > 85 ? "danger" : ($cpuPct > 65 ? "warning" : "success")
            ],
            "network" => [
                "rx_mb" => $rxMb,
                "tx_mb" => $txMb,
                "rx_formatted" => $rxMb > 1024 ? round($rxMb / 1024, 2) . " GB" : $rxMb . " MB",
                "tx_formatted" => $txMb > 1024 ? round($txMb / 1024, 2) . " GB" : $txMb . " MB"
            ]
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => $e->getMessage()]);
    }
} elseif ($action === 'switch_db_server') {
    try {
        $target = strtolower(trim($_POST['target'] ?? $_GET['target'] ?? ''));

        $serverPresets = [
            'simpam' => [
                'host' => '192.168.0.10',
                'port' => 3306,
                'user' => 'root',
                'pass' => 'xyz123',
                'name' => 'simpadu',
                'label' => 'SIMPAM (Development)',
                'env_type' => 'Development'
            ],
            'simpadu' => [
                'host' => '192.168.8.11',
                'port' => 3306,
                'user' => 'root',
                'pass' => 'xyz123',
                'name' => 'simpadu',
                'label' => 'SIMPADU (Production)',
                'env_type' => 'Production'
            ],
            'localhost' => [
                'host' => '127.0.0.1',
                'port' => 3306,
                'user' => 'root',
                'pass' => 'xyz123',
                'name' => 'simpadu',
                'label' => 'Localhost (127.0.0.1)',
                'env_type' => 'Local'
            ]
        ];

        // Also allow passing direct IP
        if ($target === '192.168.0.10') $target = 'simpam';
        if ($target === '192.168.8.11') $target = 'simpadu';
        if ($target === '127.0.0.1') $target = 'localhost';

        if (!isset($serverPresets[$target])) {
            throw new Exception("Preset server '$target' tidak valid. Pilihan yang tersedia: 'simpam' atau 'simpadu'.");
        }

        $preset = $serverPresets[$target];

        // Pre-flight connection test (timeout 3 seconds)
        $testDsn = "mysql:host={$preset['host']};port={$preset['port']};dbname={$preset['name']};charset=utf8mb4";
        $testOptions = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 3
        ];

        try {
            $testPdo = new PDO($testDsn, $preset['user'], $preset['pass'], $testOptions);
            $testPdo->query("SELECT 1");
        } catch (\PDOException $pe) {
            throw new Exception("Gagal terhubung ke {$preset['label']} ({$preset['host']}): " . $pe->getMessage());
        }

        // Tulis konfigurasi baru ke file .env
        $envContent = "# Database Configuration\n" .
                      "DB_HOST=" . $preset['host'] . "\n" .
                      "DB_USER=" . $preset['user'] . "\n" .
                      "DB_PASS=" . $preset['pass'] . "\n" .
                      "DB_NAME=" . $preset['name'] . "\n" .
                      "PORT=" . $preset['port'] . "\n";

        file_put_contents($envFile, $envContent);

        echo json_encode([
            "status" => "success",
            "message" => "Berhasil beralih ke {$preset['label']}",
            "target" => $target,
            "host" => $preset['host'],
            "label" => $preset['label'],
            "env_type" => $preset['env_type']
        ]);
    } catch (Exception $e) {
        http_response_code(400);
        echo json_encode([
            "status" => "error",
            "message" => $e->getMessage()
        ]);
    }
} else {
    echo json_encode(["message" => "Welcome to API. Use ?action=beli, ?action=batal, ?action=dibeli, ?action=get_config, ?action=get_logs, ?action=get_backups, ?action=run_backup, ?action=run_restore, ?action=run_pipeline, ?action=get_pipeline_logs, ?action=get_server_metrics, or ?action=switch_db_server"]);
}

