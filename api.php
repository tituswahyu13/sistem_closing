<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");
set_time_limit(0);
ini_set('memory_limit', '512M');
date_default_timezone_set('Asia/Jakarta');

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
            LEFT JOIN spd_tunggak t ON t.NO_PDAM = a.NO_PDAM 
                AND t.IS_YKK = 1 
                AND t.IS_DELETE = '0'
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
            $rawFiles = glob("{$backupDir}/*.sql.gz");
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
        $backupScript = __DIR__ . '/backup_simpadu.php';
        $cmd = sprintf("nohup php %s > /dev/null 2>&1 &", escapeshellarg($backupScript));
        exec($cmd);

        echo json_encode([
            "status" => "success",
            "message" => "Proses pencadangan database 'simpadu' telah dimulai di latar belakang.",
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

        // Cek SHOW FULL PROCESSLIST di server MySQL untuk query mysqldump / backup
        $stmt = $pdo->query("SHOW FULL PROCESSLIST");
        $processes = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($processes as $p) {
            $info = trim($p['Info'] ?? '');
            $db = $p['db'] ?? '';
            if (!empty($info) && ($db === 'simpadu' || stripos($info, 'SQL_NO_CACHE') !== false || stripos($info, 'SELECT') !== false || stripos($info, 'SHOW CREATE TABLE') !== false)) {
                if (stripos($info, 'SHOW FULL PROCESSLIST') === false && stripos($info, 'ykk_config') === false) {
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

        $elapsedSeconds = $startTime ? (time() - strtotime($startTime)) : 0;
        $isReallyActive = !empty($activeQuery) || $isWriting || (!$isFinished && $elapsedSeconds > 0 && $elapsedSeconds < 1800);

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
            "active_table" => $activeTable,
            "query_snippet" => $querySnippet,
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

        $elapsedSeconds = $startTime ? (time() - strtotime($startTime)) : 0;
        if (!$activeQuery && !empty($startTime) && !$isFinished) {
            $isFinished = true;
            $finishDuration = $elapsedSeconds;
            $succLine = "[" . date('Y-m-d H:i:s') . "] SUCCESS: Pemulihan database '$targetDbName' berhasil selesai dalam $finishDuration detik.";
            file_put_contents($logFile, $succLine . "\n", FILE_APPEND);
            $lastLog = $succLine;
        }

        $isReallyActive = !empty($activeQuery);

        echo json_encode([
            "status" => "success",
            "is_active" => $isReallyActive,
            "is_finished" => $isFinished,
            "finish_duration" => $finishDuration,
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
            }
            $batches[$bId]['steps'][] = $row;
        }

        // Cek progres realtime pencadangan database (Tahap 1)
        $activeBackup = null;
        $backupDir = __DIR__ . '/backups';
        if (is_dir($backupDir)) {
            $files = glob($backupDir . '/simpadu_*.sql.gz');
            if ($files) {
                usort($files, function($a, $b) { return filemtime($b) - filemtime($a); });
                $latestFile = $files[0];
                $mtime = filemtime($latestFile);
                $sizeBytes = filesize($latestFile);
                $sizeMb = round($sizeBytes / (1024 * 1024), 2);
                
                // Cari estimasi ukuran referensi dari file backup sukses sebelumnya
                $refSizeMb = 492.0;
                foreach ($files as $f) {
                    $sz = round(filesize($f) / (1024 * 1024), 2);
                    if ($f !== $latestFile && $sz > 50) {
                        $refSizeMb = $sz;
                        break;
                    }
                }

                $isWriting = (time() - $mtime) < 45;
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

        // Cek query aktif di MySQL server untuk pipeline
        $activeQuery = null;
        $activeTable = null;
        $querySnippet = null;

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
} else {
    echo json_encode(["message" => "Welcome to API. Use ?action=beli, ?action=batal, ?action=dibeli, ?action=get_config, ?action=get_logs, ?action=get_backups, ?action=run_backup, ?action=run_restore, ?action=run_pipeline, or ?action=get_pipeline_logs"]);
}

