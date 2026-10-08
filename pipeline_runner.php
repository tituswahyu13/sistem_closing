<?php
// ====================================================================
// MASTER PIPELINE RUNNER (6-STEP SEQUENTIAL PROCESS)
// Alur Terjadwal Terintegrasi:
//   Tahap 0: Set Status Mode Maintenance (UPDATE `pdam`.`info` SET `OFFLINE` = '0')
//   Tahap 1: Pencadangan Database (Backup database 'simpadu' ke .sql.gz)
//   Tahap 2: Transaksi Beli YKK (Eksekusi Stored Procedure Beli YKK)
//   Tahap 3: Transaksi Tutup Tagihan (Tutup Periode & Pindah Rekening ke Tunggakan)
//   Tahap 4: Transaksi Transfer PPOB (Truncate & Isi Ulang `pdam`.`ppob`)
//   Tahap 5: Set Status Mode Online Kembali (UPDATE `pdam`.`info` SET `OFFLINE` = '1')
// ====================================================================

date_default_timezone_set('Asia/Jakarta');
set_time_limit(0);
ini_set('memory_limit', '1024M');

require_once __DIR__ . '/backup_simpadu.php';

function getMasterPipelineDb() {
    $env = loadBackupEnv();
    $host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
    $db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
    $user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
    $pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : '';
    $port = !empty($env['PORT']) ? $env['PORT'] : '3306';

    $dsn = "mysql:host=$host;port=$port;dbname=$db;charset=utf8mb4";
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => true,
    ];
    return new PDO($dsn, $user, $pass, $options);
}

/**
 * Buat tabel log master pipeline jika belum ada
 */
function initPipelineLogTable($pdo) {
    $sql = "
    CREATE TABLE IF NOT EXISTS pipeline_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        batch_id VARCHAR(64) NOT NULL,
        periode VARCHAR(6) NOT NULL,
        step INT NOT NULL,
        step_name VARCHAR(100) NOT NULL,
        status ENUM('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED') NOT NULL,
        waktu_mulai DATETIME NOT NULL,
        waktu_selesai DATETIME NULL,
        durasi_detik DECIMAL(8,2) DEFAULT 0.00,
        pesan TEXT NULL,
        metadata_json LONGTEXT NULL,
        INDEX idx_batch (batch_id),
        INDEX idx_periode (periode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ";
    $pdo->exec($sql);
}

function getDbTablesMap($pdo) {
    static $map = null;
    if ($map === null) {
        $map = [];
        try {
            $stmt = $pdo->query("SHOW TABLES");
            while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                $map[strtolower($row[0])] = $row[0];
            }
        } catch (Exception $e) {}
    }
    return $map;
}

function resolvePipelineTableName($pdo, $name) {
    $map = getDbTablesMap($pdo);
    $lower = strtolower($name);
    return $map[$lower] ?? $name;
}

function checkPipelineTableExists($pdo, $name) {
    $map = getDbTablesMap($pdo);
    return isset($map[strtolower($name)]);
}

/**
 * Log status tahap ke database & file
 */
function recordPipelineStep($pdo, $batchId, $periode, $step, $stepName, $status, $waktuMulai, $waktuSelesai = null, $pesan = '', $metadata = []) {
    try {
        $durasi = 0;
        if ($waktuSelesai) {
            $durasi = round(strtotime($waktuSelesai) - strtotime($waktuMulai), 2);
        }
        $metaJson = !empty($metadata) ? json_encode($metadata, JSON_UNESCAPED_UNICODE) : null;
        
        // Cek apakah step sudah pernah dicatat dalam batch ini
        $cek = $pdo->prepare("SELECT id FROM pipeline_log WHERE batch_id = :bId AND step = :st LIMIT 1");
        $cek->execute(['bId' => $batchId, 'st' => $step]);
        $existing = $cek->fetch();

        if ($existing) {
            $stmt = $pdo->prepare("
                UPDATE pipeline_log 
                SET status = :status, waktu_selesai = :waktu_selesai, durasi_detik = :durasi_detik, pesan = :pesan, metadata_json = :metadata_json
                WHERE id = :id
            ");
            $stmt->execute([
                'id' => $existing['id'],
                'status' => $status,
                'waktu_selesai' => $waktuSelesai,
                'durasi_detik' => $durasi,
                'pesan' => $pesan,
                'metadata_json' => $metaJson
            ]);
        } else {
            $stmt = $pdo->prepare("
                INSERT INTO pipeline_log 
                (batch_id, periode, step, step_name, status, waktu_mulai, waktu_selesai, durasi_detik, pesan, metadata_json)
                VALUES (:batch_id, :periode, :step, :step_name, :status, :waktu_mulai, :waktu_selesai, :durasi_detik, :pesan, :metadata_json)
            ");
            $stmt->execute([
                'batch_id' => $batchId,
                'periode' => $periode,
                'step' => $step,
                'step_name' => $stepName,
                'status' => $status,
                'waktu_mulai' => $waktuMulai,
                'waktu_selesai' => $waktuSelesai,
                'durasi_detik' => $durasi,
                'pesan' => $pesan,
                'metadata_json' => $metaJson
            ]);
        }
    } catch (Exception $e) {
        error_log("Gagal log pipeline step: " . $e->getMessage());
    }
}

/**
 * Runner Utama Master Pipeline
 */
function executeMasterPipeline($options = []) {
    $executedBy = $options['executed_by'] ?? 'SYSTEM_CRON';
    $userId = intval($options['user_id'] ?? 1);
    $customBudget = isset($options['budget']) ? floatval($options['budget']) : null;
    $batchId = 'BATCH_' . date('Ymd_His') . '_' . substr(md5(uniqid(rand(), true)), 0, 6);

    $logOutput = [];
    $log = function($msg) use (&$logOutput) {
        $ts = date('Y-m-d H:i:s');
        $line = "[$ts] $msg";
        $logOutput[] = $line;
        echo $line . PHP_EOL;
    };

    $log("====================================================================");
    $log("MEMULAI MASTER PIPELINE OTOMATISASI PENUTUPAN TAGIHAN & PPOB");
    $log("Batch ID: $batchId | Executed By: $executedBy | User ID: $userId");
    $log("====================================================================");

    $pipelineResult = [
        'success' => false,
        'batch_id' => $batchId,
        'periode' => '',
        'steps' => [],
        'waktu_mulai' => date('Y-m-d H:i:s'),
        'waktu_selesai' => null,
        'durasi_total_detik' => 0,
        'logs' => &$logOutput
    ];

    $startTimeAll = microtime(true);
    $pdo = null;

    try {
        $pdo = getMasterPipelineDb();
        initPipelineLogTable($pdo);

        // -------------------------------------------------------------
        // DETEKSI PERIODE AKTIF DARI TUTUP TAGIHAN & PERIODE REKENING
        // Target Periode Eksekusi = Periode Aktif - 1 Bulan
        // -------------------------------------------------------------
        $tutupTagihanAktif = $pdo->query("SELECT * FROM spd_tutuptagihan WHERE IS_TUTUP = 0 LIMIT 1")->fetch();
        $periodeRekeningAktif = $pdo->query("SELECT * FROM spd_periode WHERE IS_TUTUP = 0 LIMIT 1")->fetch();

        if (!$tutupTagihanAktif) {
            throw new Exception("Tidak ditemukan data periode aktif pada spd_tutuptagihan (IS_TUTUP = 0).");
        }
        if (!$periodeRekeningAktif) {
            throw new Exception("Tidak ditemukan data periode aktif pada spd_periode (IS_TUTUP = 0).");
        }

        $periodeBerjalan = $tutupTagihanAktif['PERIODE']; // e.g. 202609
        $tahun = substr($periodeBerjalan, 0, 4);
        $bulan = substr($periodeBerjalan, 4, 2);

        // Target eksekusi adalah 1 bulan sebelum periode aktif tutup tagihan
        $periodeTargetEksekusi = date('Ym', strtotime("$tahun-$bulan-01 -1 months"));
        $pipelineResult['periode'] = $periodeTargetEksekusi;

        $prev_bulan = $periodeTargetEksekusi;
        $next_tahun = date('Y', strtotime("$tahun-$bulan-01 +1 months"));
        $next_bulan = date('m', strtotime("$tahun-$bulan-01 +1 months"));

        $log("Deteksi Periode Otomatis:");
        $log(" - Periode TutupTagihan Aktif di Database: $periodeBerjalan");
        $log(" - Periode TARGET EKSEKUSI (Periode Aktif - 1 Bulan): $periodeTargetEksekusi");
        $log(" - Periode Baru Setelah Tutup Tagihan: {$next_tahun}{$next_bulan}");

        // Cari budget dari ykk_config jika tidak ditentukan manual
        $budgetPlafon = 0;
        if ($customBudget !== null) {
            $budgetPlafon = $customBudget;
        } else {
            $stmtConf = $pdo->prepare("SELECT budget_plafon FROM ykk_config WHERE periode = :periode LIMIT 1");
            $stmtConf->execute(['periode' => $periodeBerjalan]);
            $confRow = $stmtConf->fetch();
            if ($confRow) {
                $budgetPlafon = floatval($confRow['budget_plafon']);
            }
        }
        $log(" - Plafon Budget YKK: Rp " . number_format($budgetPlafon, 0, ',', '.'));

        // =============================================================
        // TAHAP 0: SET INFO OFFLINE = '0' (MODE MAINTENANCE / PROSES)
        // =============================================================
        $step0Name = "Tahap 0: Set Status Mode Maintenance (OFFLINE = '0')";
        $log("\n>>> Menjalankan $step0Name...");
        $t0_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 0, $step0Name, 'RUNNING', $t0_start);
        
        $pdo->exec("UPDATE `pdam`.`info` SET `OFFLINE` = '0'");
        $t0_end = date('Y-m-d H:i:s');
        $log("✓ $step0Name berhasil. Sistem PPOB diset offline untuk proses batch.");
        
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 0, $step0Name, 'SUCCESS', $t0_start, $t0_end, 'OFFLINE = 0');
        $pipelineResult['steps'][0] = ['name' => $step0Name, 'status' => 'SUCCESS', 'pesan' => 'OFFLINE diset 0'];

        // =============================================================
        // TAHAP 1: PENCADANGAN DATABASE (BACKUP SIMPADU KE .SQL.GZ)
        // =============================================================
        $step1Name = "Tahap 1: Pencadangan Database (Backup DB simpadu)";
        $log("\n>>> Menjalankan $step1Name...");
        $t1_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 1, $step1Name, 'RUNNING', $t1_start);
        
        $backupResult = executeBackup('CLOSING_TAGIHAN');
        if (!$backupResult['success']) {
            throw new Exception("Pencadangan database gagal: " . $backupResult['message']);
        }
        $t1_end = date('Y-m-d H:i:s');
        $log("✓ $step1Name berhasil. File: {$backupResult['filename']} ({$backupResult['size_mb']} MB).");
        
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 1, $step1Name, 'SUCCESS', $t1_start, $t1_end, $backupResult['message'], $backupResult);
        $pipelineResult['steps'][1] = ['name' => $step1Name, 'status' => 'SUCCESS', 'pesan' => $backupResult['message'], 'data' => $backupResult];

        // =============================================================
        // TAHAP 2: TRANSAKSI BELI YKK (EKSEKUSI SP_EKSEKUSI_BELI_YKK)
        // =============================================================
        $step2Name = "Tahap 2: Transaksi Beli YKK (Periode $periodeTargetEksekusi)";
        $log("\n>>> Menjalankan $step2Name...");
        $t2_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeTargetEksekusi, 2, $step2Name, 'RUNNING', $t2_start);

        // Pastikan Stored Procedure dieksekusi untuk periode target (Periode Aktif - 1 Bulan)
        $stmtSp = $pdo->prepare("CALL sp_eksekusi_beli_ykk(:periode, :budget, :user_id, 0, :executed_by)");
        $stmtSp->execute([
            'periode' => $periodeTargetEksekusi,
            'budget' => $budgetPlafon,
            'user_id' => $userId,
            'executed_by' => $executedBy
        ]);
        $resYkk = $stmtSp->fetch();
        $stmtSp->closeCursor();

        $t2_end = date('Y-m-d H:i:s');
        if (!$resYkk || ($resYkk['status'] ?? '') !== 'SUCCESS') {
            $msgYkk = $resYkk['pesan'] ?? 'Eksekusi Beli YKK gagal atau mengembalikan status tidak valid.';
            throw new Exception("Gagal pada $step2Name: " . $msgYkk);
        }

        $totalTerbeli = intval($resYkk['total_rekening'] ?? 0);
        $totalBayar = floatval($resYkk['total_bayar'] ?? 0);
        $msgYkk = $resYkk['pesan'] ?? "Sukses membeli $totalTerbeli rekening (Rp " . number_format($totalBayar, 0, ',', '.') . ")";

        $log("✓ $step2Name berhasil: Terbeli $totalTerbeli rekening, Total Bayar: Rp " . number_format($totalBayar, 0, ',', '.'));
        recordPipelineStep($pdo, $batchId, $periodeTargetEksekusi, 2, $step2Name, 'SUCCESS', $t2_start, $t2_end, $msgYkk, $resYkk);
        $pipelineResult['steps'][2] = ['name' => $step2Name, 'status' => 'SUCCESS', 'pesan' => $msgYkk, 'data' => $resYkk];

        // =============================================================
        // TAHAP 3: TRANSAKSI TUTUP TAGIHAN (TUTUP PERIODE & PINDAH TUNGGAKAN)
        // =============================================================
        $step3Name = "Tahap 3: Transaksi Tutup Tagihan";
        $log("\n>>> Menjalankan $step3Name...");
        $t3_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'RUNNING', $t3_start);

        $pdo->beginTransaction();
        try {
            // 3a. Update tutup periode yang lama
            $pdo->prepare("UPDATE spd_tutuptagihan SET IS_TUTUP = 1, TIME_UPDATE = :now WHERE IS_TUTUP = 0")
                ->execute(['now' => date('Y-m-d')]);

            // 3b. Buat record periode baru di spd_tutuptagihan
            $newPeriodeCode = $next_tahun . $next_bulan;
            $pdo->prepare("INSERT INTO spd_tutuptagihan (PERIODE, IS_TUTUP) VALUES (:periode, 0)")
                ->execute(['periode' => $newPeriodeCode]);

            // 3c. Cek jumlah data rekening belum lunas pada prev_bulan
            $cekRekening = $pdo->prepare("
                SELECT COUNT(*) as jml, SUM(RK + MATERAI) as rk, SUM(NON_AIR) as non_air,
                       SUM(CASE WHEN RK+NON_AIR+MATERAI <= 50000 THEN 5000 ELSE pembulatanUang((RK+NON_AIR+MATERAI) * 0.1) END) as denda
                FROM spd_rekening
                WHERE PERIODE = :prev_bulan AND IS_TUTUPMETER = 1 AND FLAG = 0 AND STATUS IN ('A', 'T')
            ");
            $cekRekening->execute(['prev_bulan' => $prev_bulan]);
            $dataPindahan = $cekRekening->fetch();

            $totalPindah = intval($dataPindahan['jml'] ?? 0);
            $log("   - Rekening dipindahkan ke Tunggakan (Periode $prev_bulan): $totalPindah pelanggan.");

            if ($totalPindah > 0) {
                // 3d. Insert ke SPD_TUNGGAK dengan casting IS_YKK integer aman
                $insertTunggakSql = "
                INSERT INTO spd_tunggak (
                    TANGGAL, REKENING_BULAN, NON_AIR, AIR, DENDA, MATERAI, SUBSIDI, JUMLAH,
                    LOKBAY_ID, STLGN_ID, NO_PDAM, STGOL_ID, LUNAS, ONLINE, NOSERIAL, PH, TANGGAL_PH,
                    IS_DELETE, IS_YKK, USER_ID_CREATE, TIME_CREATE
                )
                SELECT 
                    NULL, 
                    CONCAT(LEFT(PERIODE,4), '-', RIGHT(PERIODE,2), '-20'), 
                    NON_AIR, 
                    RK, 
                    CASE WHEN RK+NON_AIR+MATERAI <= 50000 THEN 5000 ELSE pembulatanUang((RK+NON_AIR+MATERAI) * 0.1) END,
                    MATERAI, 
                    SUBSIDI, 
                    RK+NON_AIR+MATERAI+CASE WHEN RK+NON_AIR+MATERAI <= 50000 THEN 5000 ELSE pembulatanUang((RK+NON_AIR+MATERAI) * 0.1) END,
                    LOKBAY_ID, 
                    STLGN_ID, 
                    NO_PDAM, 
                    STGOL_ID, 
                    0, 
                    NULL, 
                    NULL, 
                    NULL, 
                    NULL, 
                    0, 
                    IF(IS_YKK = 1 OR IS_YKK = '1', 1, 0), 
                    :user_id, 
                    NOW()
                FROM spd_rekening
                WHERE PERIODE = :prev_bulan AND IS_TUTUPMETER = 1 AND FLAG = 0 AND STATUS IN ('A','T')
                ";
                $stmtIns = $pdo->prepare($insertTunggakSql);
                $stmtIns->execute([
                    'user_id' => $userId,
                    'prev_bulan' => $prev_bulan
                ]);

                // 3e. Update status di SPD_REKENING
                $updateRekeningSql = "
                UPDATE spd_rekening a 
                SET a.FLAG = 1, a.IS_TUNGGAK = 1 
                WHERE a.PERIODE = :prev_bulan AND IS_TUTUPMETER = 1 AND FLAG = 0 AND STATUS IN ('A','T')
                ";
                $stmtUpd = $pdo->prepare($updateRekeningSql);
                $stmtUpd->execute(['prev_bulan' => $prev_bulan]);
            }

            $pdo->commit();
            $t3_end = date('Y-m-d H:i:s');
            $msgTutupTagihan = "Tutup Tagihan berhasil. Periode baru: $newPeriodeCode. Dipindah ke tunggak: $totalPindah pelanggan.";
            $log("✓ $step3Name berhasil. $msgTutupTagihan");

            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'SUCCESS', $t3_start, $t3_end, $msgTutupTagihan, $dataPindahan);
            $pipelineResult['steps'][3] = ['name' => $step3Name, 'status' => 'SUCCESS', 'pesan' => $msgTutupTagihan, 'data' => $dataPindahan];

        } catch (Exception $e) {
            $pdo->rollBack();
            throw new Exception("Gagal pada $step3Name: " . $e->getMessage());
        }

        // =============================================================
        // TAHAP 4: TRANSAKSI TRANSFER PPOB (TRUNCATE & INSERT KE PDAM.PPOB)
        // =============================================================
        $step4Name = "Tahap 4: Transaksi Transfer Tagihan ke PPOB";
        $log("\n>>> Menjalankan $step4Name...");
        $t4_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 4, $step4Name, 'RUNNING', $t4_start);

        // Parameter periode rekening untuk PPOB
        $perRekening = $pdo->query("SELECT * FROM spd_periode WHERE IS_TUTUP = 0 LIMIT 1")->fetch();
        $targetYear = date('Y', strtotime("{$perRekening['TAHUN']}-{$perRekening['BULAN']}-01 -1 months"));
        $targetMonth = date('m', strtotime("{$perRekening['TAHUN']}-{$perRekening['BULAN']}-01 -1 months"));
        $periodeRekBulan = $targetYear . $targetMonth;
        $blntagCode = $perRekening['TAHUN'] . $perRekening['BULAN'];

        try {
            // 4a. Deteksi Duplikasi & Validasi Awal Sebelum Insert
            $log("   - Menjalankan deteksi awal data ganda/duplikat...");
            
            // Cek duplikasi di Tagihan Berjalan
            $cekDupTagrek = $pdo->prepare("
                SELECT a.NO_PDAM, b.NAMA, COUNT(*) as jml_kembar
                FROM spd_tagrek a
                JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                JOIN spd_lokbay f ON f.ID = a.LOKBAY_ID
                WHERE a.REKENING_BULAN = :periode_rek AND f.PPOB = 3 AND a.IS_DELETE = 0 AND a.IS_YKK = 0
                GROUP BY a.NO_PDAM
                HAVING COUNT(*) > 1
            ");
            $cekDupTagrek->execute(['periode_rek' => $periodeRekBulan]);
            $dupTagrekList = $cekDupTagrek->fetchAll();

            if (!empty($dupTagrekList)) {
                $log("   [PERINGATAN DUPLIKAT] Ditemukan " . count($dupTagrekList) . " nomor pelanggan ganda di Tagihan Berjalan (spd_tagrek):");
                foreach (array_slice($dupTagrekList, 0, 5) as $dup) {
                    $log("     * NO_PDAM: {$dup['NO_PDAM']} ({$dup['NAMA']}) - Muncul {$dup['jml_kembar']}x");
                }
            }

            // Cek duplikasi di Tunggakan (Kombinasi NO_PDAM + Periode Rekening Bulan)
            $cekDupTunggak = $pdo->query("
                SELECT a.NO_PDAM, b.NAMA, DATE_FORMAT(a.REKENING_BULAN, '%Y%m') as per, COUNT(*) as jml_kembar
                FROM spd_tunggak a
                JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                JOIN spd_lokbay g ON g.ID = b.LOKBAY_ID
                WHERE a.LUNAS = 0 AND g.PPOB = 3 AND a.IS_DELETE = 0 AND a.PH IS NULL
                GROUP BY a.NO_PDAM, DATE_FORMAT(a.REKENING_BULAN, '%Y%m')
                HAVING COUNT(*) > 1
            ");
            $dupTunggakList = $cekDupTunggak->fetchAll();

            if (!empty($dupTunggakList)) {
                $log("   [PERINGATAN DUPLIKAT] Ditemukan " . count($dupTunggakList) . " tunggakan ganda pada periode yang sama (spd_tunggak):");
                foreach (array_slice($dupTunggakList, 0, 5) as $dup) {
                    $log("     * NO_PDAM: {$dup['NO_PDAM']} ({$dup['NAMA']}) Periode {$dup['per']} - Muncul {$dup['jml_kembar']}x");
                }
            }

            // Cek Duplikasi SILANG (NO_PDAM & Periode sama ada di spd_tagrek DAN spd_tunggak)
            $cekDupSilang = $pdo->prepare("
                SELECT a.NO_PDAM, b.NAMA, a.REKENING_BULAN as periode, a.JUMLAH as tagihan_tagrek, t.JUMLAH as tagihan_tunggak
                FROM spd_tagrek a
                JOIN spd_tunggak t ON t.NO_PDAM = a.NO_PDAM 
                    AND DATE_FORMAT(t.REKENING_BULAN, '%Y%m') = a.REKENING_BULAN
                    AND t.LUNAS = 0 AND t.IS_DELETE = 0 AND t.PH IS NULL
                JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                JOIN spd_lokbay f ON f.ID = a.LOKBAY_ID
                WHERE a.REKENING_BULAN = :periode_rek AND f.PPOB = 3 AND a.IS_DELETE = 0 AND a.IS_YKK = 0
                GROUP BY a.NO_PDAM
            ");
            $cekDupSilang->execute(['periode_rek' => $periodeRekBulan]);
            $dupSilangList = $cekDupSilang->fetchAll();

            if (!empty($dupSilangList)) {
                $log("   [PERINGATAN DUPLIKAT SILANG] Ditemukan " . count($dupSilangList) . " rekening sama di spd_tagrek & spd_tunggak:");
                foreach (array_slice($dupSilangList, 0, 5) as $dup) {
                    $log("     * NO_PDAM: {$dup['NO_PDAM']} ({$dup['NAMA']}) Periode {$dup['periode']} (Tagrek: Rp " . number_format($dup['tagihan_tagrek'], 0, ',', '.') . " vs Tunggak: Rp " . number_format($dup['tagihan_tunggak'], 0, ',', '.') . ")");
                }
                $log("     => Sistem otomatis memprioritaskan Tagihan Berjalan dan memfilter tunggakan kembar agar tidak masuk ganda ke PPOB.");
            }

            // 4b. Truncate tabel pdam.ppob (DDL statement)
            $pdo->exec("TRUNCATE `pdam`.ppob");
            $log("   - Truncate tabel pdam.ppob selesai.");

            // Mulai transaksi untuk batch INSERT ke pdam.ppob
            $pdo->beginTransaction();

            // 4c. Insert Tagihan Berjalan dengan INSERT IGNORE & subquery agregasi rekang
            $sqlPpobTagrek = "
            INSERT IGNORE INTO `pdam`.ppob
            SELECT 
                a.NO_PDAM, 
                b.NAMA, 
                b.ALAMAT,
                CONCAT(c.KETERANGAN, ' (', d.STGOL_ID, ')') AS GOL,
                IF(d.EDITMETER = 0, d.METER, d.EDITMETER) AS MTRINI, 
                d.METERLALU, 
                d.VOLUME_TAGIHAN AS PAKAI,
                (d.RK + d.MATERAI) AS TAGAIR, 
                a.NON_AIR AS TAGNONAIR,
                IFNULL(CONCAT('(', e.XANGSUR, '/', e.XRLANG, ')'), '') AS ANGS_KE, 
                0 AS DENDA, 
                a.SUBSIDI AS SUBSIDI, 
                (a.JUMLAH - a.SUBSIDI) AS TOTTAG, 
                :blntag AS BLNTAG, 
                CONCAT(1, '.', a.NO_PDAM, '.', a.REKENING_BULAN, '.', LEFT(a.JUMLAH, 4)) AS NOSERIAL, 
                a.TANGGAL AS TGL_LUNAS, 
                TIME_FORMAT(a.TIME_CREATE, '%H:%i:%s') AS TIME_LUNAS, 
                1 AS REK, 
                IF(a.ONLINE = 0, 7, a.ONLINE) AS FLAG, 
                1 AS TRANSFER, 
                a.LOKBAY_ID AS LOKBYR, 
                1 AS AKTIF
            FROM spd_tagrek a
            JOIN spd_stlgn b ON b.ID = a.STLGN_ID
            JOIN spd_stgol c ON c.ID = a.STGOL_ID
            JOIN spd_rekening d ON d.STLGN_ID = a.STLGN_ID AND d.PERIODE = :periode_rek AND d.`STATUS` NOT IN ('L')
            LEFT JOIN (
                SELECT a.STLGN_ID, MAX(a.XANGSUR) AS XANGSUR, MAX(a.XRLANG + 1) AS XRLANG
                FROM spd_rekang a
                WHERE DATE_FORMAT(a.TANGGAL, '%Y%m') = :periode_rek
                GROUP BY a.STLGN_ID
            ) e ON e.STLGN_ID = a.STLGN_ID
            JOIN spd_lokbay f ON f.ID = a.LOKBAY_ID
            WHERE a.REKENING_BULAN = :periode_rek AND f.PPOB = 3 AND a.IS_DELETE = 0 AND a.IS_YKK = 0
            GROUP BY a.NO_PDAM
            ";
            $stmtPpob1 = $pdo->prepare($sqlPpobTagrek);
            $stmtPpob1->execute([
                'blntag' => $blntagCode,
                'periode_rek' => $periodeRekBulan
            ]);
            $jmlPpobTagrek = $stmtPpob1->rowCount();
            $log("   - Insert Tagihan Berjalan ke pdam.ppob: $jmlPpobTagrek baris.");

            // 4d. Insert Tunggakan dengan INSERT IGNORE, subquery agregasi rekang, & proteksi NOT EXISTS terhadap tagrek aktif
            $sqlPpobTunggak = "
            INSERT IGNORE INTO `pdam`.ppob
            SELECT 
                a.NO_PDAM, 
                b.NAMA, 
                b.ALAMAT,
                CONCAT(c.KETERANGAN, ' (', a.STGOL_ID, ')') AS GOL,
                IFNULL(d.MTRINI, 0), 
                IFNULL(d.METERLALU, 0) AS METERLALU, 
                IFNULL(d.PAKAI, 0),
                (a.AIR + a.MATERAI) AS TAGAIR, 
                a.NON_AIR AS TAGNONAIR,
                IFNULL(CONCAT('(', e.XANGSUR, '/', e.XRLANG, ')'), '') AS ANGS_KE, 
                a.DENDA AS DENDA, 
                a.SUBSIDI AS SUBSIDI, 
                (a.JUMLAH - a.SUBSIDI) AS TOTTAG,
                DATE_FORMAT(DATE_SUB(a.REKENING_BULAN, INTERVAL -1 MONTH), '%Y%m') AS BLNTAG, 
                CONCAT(IF(a.IS_YKK = 1, 3, 2), '.', a.NO_PDAM, '.', DATE_FORMAT(a.REKENING_BULAN, '%Y%m'), '.', LEFT(a.JUMLAH, 4)) AS NOSERIAL, 
                NULL AS TGL_LUNAS, 
                NULL AS TIME_LUNAS, 
                IF(a.IS_YKK = 1, 3, 2) AS REK, 
                0 AS FLAG, 
                0 AS TRANSFER, 
                a.LOKBAY_ID AS LOKBYR, 
                IF(f.STATUS IN ('L'), 2, 0) AS AKTIF
            FROM spd_tunggak a
            JOIN spd_stlgn b ON b.ID = a.STLGN_ID
            JOIN spd_stgol c ON c.ID = a.STGOL_ID
            LEFT JOIN (
                SELECT a.STLGN_ID, a.PERIODE, IFNULL(IF(a.EDITMETER = 0, a.METER, a.EDITMETER), 0) AS MTRINI, a.METERLALU, a.VOLUME_TAGIHAN AS PAKAI
                FROM spd_rekening a
            ) d ON d.STLGN_ID = a.STLGN_ID AND d.PERIODE = DATE_FORMAT(a.REKENING_BULAN, '%Y%m')
            LEFT JOIN (
                SELECT a.STLGN_ID, MAX(a.XANGSUR) AS XANGSUR, MAX(a.XRLANG + 1) AS XRLANG, DATE_FORMAT(a.TANGGAL, '%Y%m') AS PERIODE
                FROM spd_rekang a
                GROUP BY a.STLGN_ID, DATE_FORMAT(a.TANGGAL, '%Y%m')
            ) e ON e.STLGN_ID = a.STLGN_ID AND e.PERIODE = DATE_FORMAT(a.REKENING_BULAN, '%Y%m')
            LEFT JOIN (
                SELECT a.STLGN_ID, a.STATUS FROM spd_rekening a WHERE a.PERIODE = :periode_rek
            ) f ON f.STLGN_ID = a.STLGN_ID
            JOIN spd_lokbay g ON g.ID = b.LOKBAY_ID
            WHERE a.LUNAS = 0 AND g.PPOB = 3 AND a.IS_DELETE = 0 AND a.PH IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM spd_tagrek tr
                  WHERE tr.NO_PDAM = a.NO_PDAM
                    AND tr.REKENING_BULAN = DATE_FORMAT(a.REKENING_BULAN, '%Y%m')
                    AND tr.REKENING_BULAN = :periode_rek
                    AND tr.IS_DELETE = 0 AND tr.IS_YKK = 0
              )
            GROUP BY a.NO_PDAM, a.REKENING_BULAN
            ORDER BY a.REKENING_BULAN
            ";
            $stmtPpob2 = $pdo->prepare($sqlPpobTunggak);
            $stmtPpob2->execute(['periode_rek' => $periodeRekBulan]);
            $jmlPpobTunggak = $stmtPpob2->rowCount();
            $log("   - Insert Tunggakan ke pdam.ppob: $jmlPpobTunggak baris.");

            if ($pdo->inTransaction()) {
                $pdo->commit();
            }
            $t4_end = date('Y-m-d H:i:s');
            $msgPpob = "Transfer PPOB berhasil. Tagihan Berjalan: $jmlPpobTagrek, Tunggakan: $jmlPpobTunggak.";
            if (!empty($dupSilangList)) {
                $msgPpob .= " (Ditemukan " . count($dupSilangList) . " duplikat silang tagrek-tunggak, otomatis difilter).";
            }
            $log("✓ $step4Name berhasil. $msgPpob");

            $duplicateSummary = [
                'tagihan_berjalan' => $jmlPpobTagrek,
                'tunggakan' => $jmlPpobTunggak,
                'duplikat_tagrek_terdeteksi' => $dupTagrekList,
                'duplikat_tunggak_terdeteksi' => $dupTunggakList,
                'duplikat_silang_tagrek_tunggak' => $dupSilangList
            ];

            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 4, $step4Name, 'SUCCESS', $t4_start, $t4_end, $msgPpob, $duplicateSummary);
            $pipelineResult['steps'][4] = [
                'name' => $step4Name,
                'status' => 'SUCCESS',
                'pesan' => $msgPpob,
                'data' => $duplicateSummary
            ];

        } catch (Exception $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw new Exception("Gagal pada $step4Name: " . $e->getMessage());
        }

        // =============================================================
        // TAHAP 5: SET INFO OFFLINE = '1' (MODE ONLINE / SELESAI)
        // =============================================================
        $step5Name = "Tahap 5: Set Status Mode Online Kembali (OFFLINE = '1')";
        $log("\n>>> Menjalankan $step5Name...");
        $t5_start = date('Y-m-d H:i:s');
        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 5, $step5Name, 'RUNNING', $t5_start);

        $pdo->exec("UPDATE `pdam`.`info` SET `OFFLINE` = '1'");
        $t5_end = date('Y-m-d H:i:s');
        $log("✓ $step5Name berhasil. Sistem PPOB diset kembali online (aktif).");

        recordPipelineStep($pdo, $batchId, $periodeBerjalan, 5, $step5Name, 'SUCCESS', $t5_start, $t5_end, 'OFFLINE = 1');
        $pipelineResult['steps'][5] = ['name' => $step5Name, 'status' => 'SUCCESS', 'pesan' => 'OFFLINE diset 1'];

        // Selesai dengan sukses penuh
        $pipelineResult['success'] = true;
        $endTimeAll = microtime(true);
        $totalDurasi = round($endTimeAll - $startTimeAll, 2);
        $pipelineResult['durasi_total_detik'] = $totalDurasi;
        $pipelineResult['waktu_selesai'] = date('Y-m-d H:i:s');

        $log("\n====================================================================");
        $log("MASTER PIPELINE SELESAI DENGAN SUKSES! (Total Durasi: {$totalDurasi} detik)");
        $log("====================================================================");

    } catch (Exception $e) {
        $endTimeAll = microtime(true);
        $totalDurasi = round($endTimeAll - $startTimeAll, 2);
        $pipelineResult['success'] = false;
        $pipelineResult['error'] = $e->getMessage();
        $pipelineResult['durasi_total_detik'] = $totalDurasi;
        $pipelineResult['waktu_selesai'] = date('Y-m-d H:i:s');

        $log("\n[FATAL ERROR] PIPELINE DIHENTIKAN: " . $e->getMessage());

        // Catat error step
        if ($pdo && isset($periodeBerjalan)) {
            try {
                $stmtFail = $pdo->prepare("UPDATE pipeline_log SET status = 'FAILED', waktu_selesai = NOW(), pesan = :pesan WHERE batch_id = :bid AND status = 'RUNNING'");
                $stmtFail->execute(['pesan' => $e->getMessage(), 'bid' => $batchId]);
            } catch (Exception $ex) {}
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 99, "Pipeline Error", 'FAILED', date('Y-m-d H:i:s'), date('Y-m-d H:i:s'), $e->getMessage());
        }
    }

    return $pipelineResult;
}

/**
 * Eksekusi Pipeline Otomasi Closing Rekening 6-Tahap:
 *   Tahap 0: Set Status Mode Maintenance (UPDATE `pdam`.`info` SET `OFFLINE` = '0')
 *   Tahap 1: Pencadangan Database (Backup database 'simpadu' tipe CLOSING_REKENING)
 *   Tahap 2: Transaksi Closing Rekening (Kueri menyusul)
 *   Tahap 3: Transaksi Transfer PPOB (Kueri menyusul)
 *   Tahap 4: Pelunasan Rumah Ibadah (Kueri menyusul)
 *   Tahap 5: Set Status Mode Online Kembali (UPDATE `pdam`.`info` SET `OFFLINE` = '1')
 */
function executeClosingRekeningPipeline($params = []) {
    $executedBy = $params['executed_by'] ?? 'WEB_DASHBOARD';
    $userId = intval($params['user_id'] ?? 1);
    $batchId = 'BATCH_REK_' . date('Ymd_His') . '_' . substr(md5(uniqid()), 0, 6);
    $startTimeAll = microtime(true);

    $pipelineResult = [
        'pipeline_type' => 'CLOSING_REKENING',
        'batch_id' => $batchId,
        'executed_by' => $executedBy,
        'waktu_mulai' => date('Y-m-d H:i:s'),
        'waktu_selesai' => null,
        'durasi_total_detik' => 0,
        'success' => false,
        'periode' => null,
        'steps' => [],
        'logs' => [],
        'error' => null
    ];

    $log = function($msg) use (&$pipelineResult) {
        $pipelineResult['logs'][] = "[" . date('H:i:s') . "] " . $msg;
    };

    $log("====================================================================");
    $log("MEMULAI PIPELINE CLOSING REKENING 6-TAHAPAN OTOMATIS");
    $log("Batch ID: $batchId | User ID: $userId | Eksekutor: $executedBy");
    $log("====================================================================");

    $pdo = null;

    try {
        $pdo = getMasterPipelineDb();
        initPipelineLogTable($pdo);

        $resumeStep = intval($params['resume_step'] ?? 0);
        $overridePeriode = !empty($params['periode']) ? strval($params['periode']) : null;

        // Deteksi periode aktif dari spd_periode
        if ($overridePeriode) {
            $periodeBerjalan = $overridePeriode;
        } else {
            $periodeRekeningAktif = $pdo->query("SELECT * FROM spd_periode WHERE IS_TUTUP = 0 LIMIT 1")->fetch();
            if (!$periodeRekeningAktif) {
                $periodeBerjalan = date('Ym');
            } else {
                $periodeBerjalan = sprintf("%04d%02d", $periodeRekeningAktif['TAHUN'], $periodeRekeningAktif['BULAN']);
            }
        }
        $pipelineResult['periode'] = $periodeBerjalan;

        $log("Deteksi Periode Rekening Target: $periodeBerjalan (Resume Step: $resumeStep)");

        // -------------------------------------------------------------
        // TAHAP 0: SET INFO OFFLINE = '0' (MODE MAINTENANCE)
        // -------------------------------------------------------------
        if ($resumeStep <= 0) {
            $step0Name = "Tahap 0: Set Status Mode Maintenance (OFFLINE = '0')";
            $log("\n>>> Menjalankan $step0Name...");
            $t0_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 0, $step0Name, 'RUNNING', $t0_start);
            
            $pdo->exec("UPDATE `pdam`.`info` SET `OFFLINE` = '0'");
            $t0_end = date('Y-m-d H:i:s');
            $log("✓ $step0Name berhasil. Transaksi luar diset offline.");
            
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 0, $step0Name, 'SUCCESS', $t0_start, $t0_end, 'OFFLINE = 0');
            $pipelineResult['steps'][0] = ['name' => $step0Name, 'status' => 'SUCCESS', 'pesan' => 'OFFLINE diset 0'];
        }

        // -------------------------------------------------------------
        // TAHAP 1: PENCADANGAN DATABASE (BACKUP CLOSING REKENING)
        // -------------------------------------------------------------
        if ($resumeStep <= 1) {
            $step1Name = "Tahap 1: Pencadangan Database (Backup DB simpadu)";
            $log("\n>>> Menjalankan $step1Name...");
            $t1_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 1, $step1Name, 'RUNNING', $t1_start);
            
            $backupResult = executeBackup('CLOSING_REKENING');
            if (!$backupResult['success']) {
                throw new Exception("Pencadangan database closing rekening gagal: " . $backupResult['message']);
            }
            $t1_end = date('Y-m-d H:i:s');
            $log("✓ $step1Name berhasil. File: {$backupResult['filename']} ({$backupResult['size_mb']} MB).");
            
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 1, $step1Name, 'SUCCESS', $t1_start, $t1_end, $backupResult['message'], $backupResult);
            $pipelineResult['steps'][1] = ['name' => $step1Name, 'status' => 'SUCCESS', 'pesan' => $backupResult['message'], 'data' => $backupResult];
        }

        // 2. Hitung Periode Baru & Periode Lalu
        $curTahun = substr($periodeBerjalan, 0, 4);
        $curBulan = substr($periodeBerjalan, 4, 2);

        $dtNext = new DateTime("{$curTahun}-{$curBulan}-01");
        $dtNext->modify('+1 month');
        $nextTahun = $dtNext->format('Y');
        $nextBulan = $dtNext->format('m');
        $nextPeriode = $nextTahun . $nextBulan;

        $dtPrev1 = new DateTime("{$curTahun}-{$curBulan}-01");
        $dtPrev1->modify('-1 month');
        $prevPeriode1 = $dtPrev1->format('Ym');

        $dtPrev2 = new DateTime("{$curTahun}-{$curBulan}-01");
        $dtPrev2->modify('-2 month');
        $prevPeriode2 = $dtPrev2->format('Ym');

        // -------------------------------------------------------------
        // TAHAP 2: TRANSAKSI CLOSING REKENING (TUTUP REKENING)
        // -------------------------------------------------------------
        if ($resumeStep <= 2) {
            $step2Name = "Tahap 2: Transaksi Closing Rekening";
            $log("\n>>> Menjalankan $step2Name...");
            $t2_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start);

            // 1. Cek apakah masih ada rekening yang belum dikontrol (IS_CTRL = 0)
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Sedang validasi kontrol meter (IS_CTRL = 0)...');
            $stmtCtrl = $pdo->prepare("
                SELECT COUNT(*) AS jumlah 
                FROM spd_rekening
                WHERE PERIODE = :periode AND STATUS IN ('A','T') AND IS_CTRL = 0
            ");
            $stmtCtrl->execute(['periode' => $periodeBerjalan]);
            $resCtrl = $stmtCtrl->fetch(PDO::FETCH_ASSOC);
            $jmlBelumCtrl = (int)($resCtrl['jumlah'] ?? 0);

            if ($jmlBelumCtrl > 0) {
                throw new Exception("Tutup rekening dibatalkan. Masih terdapat {$jmlBelumCtrl} rekening yang belum dikontrol (IS_CTRL = 0) pada periode {$periodeBerjalan}.");
            }
            $log("   - Validasi kontrol meter: Semua rekening periode $periodeBerjalan sudah dikontrol (IS_CTRL = 1).");

            $log("   - Periode Aktif Berjalan: $periodeBerjalan ({$curBulan}-{$curTahun})");
            $log("   - Periode Baru Dibuat: $nextPeriode ({$nextBulan}-{$nextTahun})");

            // Memulai Transaksi Database
            $pdo->beginTransaction();

            try {
                // A. Update SPD_ANGSURAN
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 1/6]: UPDATE spd_angsuran (XRLANG & AKUMBAYAR)...');
            $sqlAngsuran = "
                UPDATE spd_angsuran a, (
                    SELECT a.ID, a.STLGN_ID, a.KRITERIA,
                    IF(a.VOLUME - a.AKUMBAYAR >= a.VOLUME_ANGSUR, a.VOLUME_ANGSUR, a.VOLUME - a.AKUMBAYAR) AS bayar
                    FROM spd_angsuran a
                    JOIN (
                        SELECT b.STLGN_ID, MAX(b.PERIODE) AS PERIODE
                        FROM spd_angsuran b
                        GROUP BY b.STLGN_ID
                    ) b ON b.STLGN_ID = a.STLGN_ID AND b.PERIODE = a.PERIODE
                    WHERE ((a.KRITERIA = 'administrasi' AND a.AKUMBAYAR < a.VOLUME) OR (a.KRITERIA = 'angsuran' AND a.AKUMBAYAR < a.VOLUME))
                    AND a.PERIODE < :next_periode
                ) b
                SET a.XRLANG = a.XRLANG + 1, a.AKUMBAYAR = CASE WHEN a.KRITERIA = 'angsuran' THEN a.AKUMBAYAR + b.bayar ELSE 0 END
                WHERE a.ID = b.ID
            ";
            $stmtAngsur = $pdo->prepare($sqlAngsuran);
            $stmtAngsur->execute(['next_periode' => $nextPeriode]);
            $jmlAngsurUpdated = $stmtAngsur->rowCount();
            $log("   - Update spd_angsuran: $jmlAngsurUpdated baris diperbarui.");

            // B. Generate & Insert Rekening Periode Baru (spd_rekening)
            // Hapus data periode baru jika sebelumnya pernah terbuat sebagian untuk idempotensi
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 2/6]: INSERT INTO spd_rekening periode baru ' . $nextPeriode . ' (kalkulasi rata-rata meter)...');
            $pdo->prepare("DELETE FROM spd_rekening WHERE PERIODE = :next_periode")->execute(['next_periode' => $nextPeriode]);

            $sqlInsertRekening = "
                INSERT INTO spd_rekening
                SELECT NULL, a.ID, a.NO_PDAM, a.LOKBAY_ID, a.STGOL_ID, f.next_periode
                    , 0 as meter, 0 as editmeter, IFNULL(IF(b.EDITMETER <> 0, b.EDITMETER, b.METER),0) AS meterlalu,
                    ROUND(IFNULL(( b.VOLUME_REAL + c.VOLUME_REAL + d.VOLUME_REAL ) / CASE WHEN b.STATUS_PELANGGAN = 'PB' OR b.STATUS_PELANGGAN = 'PK' THEN 1 WHEN c.STATUS_PELANGGAN = 'PB' OR c.STATUS_PELANGGAN = 'PK' THEN 2 ELSE 3 END, 0),0) AS rata2, 0 AS
                    cetak,0 AS non_air,0 AS SUBSIDI,0 AS rk,0 AS vol_real, 0 AS vol_tagihan,e.ADMINISTRASI,e.PEMELIHARAAN,0 AS mat,0 AS air,b.FLAG, NULL AS NOSERIAL, b.STATUS, NULL AS STATUS_PELANGGAN, b.IS_YKK, b.IS_TUNGGAK, 0 AS istutup, NULL AS keterangan, NULL AS longi, NULL AS lati,
                    :user_c as user_c, :user_u as user_u, NOW() as time_c, NOW() as time_u, 0 as is_edit, 0 as tbaca, 0 as xbaca, 0 as is_ctrl, IF(IFNULL(g.VOLUME_ANGSUR, 0) > 0, 1, 0) as is_angsur, a.NO_PDAM AS image, IF(g.cnt_angsur IS NOT NULL, 1, 0) AS is_blmlunas
                    , NULL AS stgol_lama, NULL as TGL_BACA, b.TGL_BACA as XTGL_BACA, g.VOLUME_ANGSUR as ANGSUR_AIR, NULL as TAGREK_TANGGAL
                FROM spd_stlgn a CROSS
                JOIN (
                    SELECT :next_periode AS next_periode, :cur_tahun AS TAHUN, :cur_bulan AS BULAN
                ) f
                LEFT JOIN `spd_rekening` AS `b` ON b.PERIODE = :cur_periode AND b.STLGN_ID = a.ID
                LEFT JOIN `spd_rekening` AS `c` ON c.PERIODE = :prev_periode1 AND c.STLGN_ID = a.ID
                LEFT JOIN `spd_rekening` AS `d` ON d.PERIODE = :prev_periode2 AND d.STLGN_ID = a.ID
                LEFT JOIN spd_biaya AS e ON e.ID = a.BIAYA_ID
                LEFT JOIN (
                    SELECT COUNT(*) AS cnt_angsur, a.STLGN_ID, sum(a.VOLUME_ANGSUR) as VOLUME_ANGSUR
                    FROM spd_angsuran a
                    LEFT JOIN (
                        SELECT a.STLGN_ID, a.KRITERIA, IF(a.VOLUME - a.AKUMBAYAR < a.VOLUME_ANGSUR, a.VOLUME - a.AKUMBAYAR, a.VOLUME_ANGSUR) nilai_angsur
                        FROM spd_angsuran a
                        JOIN (
                            SELECT b.STLGN_ID, MAX(b.PERIODE) AS PERIODE
                            FROM spd_angsuran b
                            GROUP BY b.STLGN_ID
                        ) b ON b.STLGN_ID = a.STLGN_ID AND b.PERIODE = a.PERIODE
                    ) b ON b.STLGN_ID = a.STLGN_ID
                    WHERE ((a.KRITERIA = 'administrasi' AND a.AKUMBAYAR < a.VOLUME) OR (a.KRITERIA = 'angsuran' AND a.AKUMBAYAR < a.VOLUME)) 
                    AND a.PERIODE < :next_periode_angsur
                    GROUP BY STLGN_ID
                ) g ON g.STLGN_ID = a.ID
            ";
            $stmtInsertRek = $pdo->prepare($sqlInsertRekening);
            $stmtInsertRek->execute([
                'user_c' => $userId,
                'user_u' => $userId,
                'next_periode' => $nextPeriode,
                'cur_tahun' => $curTahun,
                'cur_bulan' => $curBulan,
                'cur_periode' => $periodeBerjalan,
                'prev_periode1' => $prevPeriode1,
                'prev_periode2' => $prevPeriode2,
                'next_periode_angsur' => $nextPeriode
            ]);
            $jmlRekeningBaru = $stmtInsertRek->rowCount();
            $log("   - Generate spd_rekening Periode Baru ($nextPeriode): $jmlRekeningBaru rekening berhasil digenerate.");

            // C. Update Status Periode Lama (IS_TUTUP = 1) dan Tambah Periode Baru di spd_periode
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 3/6]: UPDATE spd_periode (Tutup ' . $periodeBerjalan . ' & buka ' . $nextPeriode . ')...');
            $stmtTutupPeriode = $pdo->prepare("
                UPDATE spd_periode 
                SET IS_TUTUP = 1, TIME_TUTUP = NOW() 
                WHERE TAHUN = :cur_tahun AND BULAN = :cur_bulan
            ");
            $stmtTutupPeriode->execute([
                'cur_tahun' => $curTahun,
                'cur_bulan' => $curBulan
            ]);

            // Cek apakah row periode baru sudah ada di spd_periode
            $stmtCekNewPer = $pdo->prepare("SELECT COUNT(*) AS cnt FROM spd_periode WHERE TAHUN = :next_tahun AND BULAN = :next_bulan");
            $stmtCekNewPer->execute(['next_tahun' => $nextTahun, 'next_bulan' => $nextBulan]);
            if ((int)$stmtCekNewPer->fetchColumn() === 0) {
                $stmtInsertNewPer = $pdo->prepare("
                    INSERT INTO spd_periode (TAHUN, BULAN, IS_TUTUP, TIME_CREATED)
                    VALUES (:next_tahun, :next_bulan, 0, NOW())
                ");
                $stmtInsertNewPer->execute(['next_tahun' => $nextTahun, 'next_bulan' => $nextBulan]);
            } else {
                $pdo->prepare("UPDATE spd_periode SET IS_TUTUP = 0, TIME_TUTUP = NULL WHERE TAHUN = :next_tahun AND BULAN = :next_bulan")
                    ->execute(['next_tahun' => $nextTahun, 'next_bulan' => $nextBulan]);
            }
            $log("   - Update spd_periode: Periode $periodeBerjalan ditutup, Periode $nextPeriode diaktifkan.");

            // D. Update BPPI (jika tabel ada)
            $tblBppi = resolvePipelineTableName($pdo, 'spd_bppi');
            $tblStlgn = resolvePipelineTableName($pdo, 'spd_stlgn');
            $tblRekening = resolvePipelineTableName($pdo, 'spd_rekening');
            $tblPidenda = resolvePipelineTableName($pdo, 'spd_pidenda');

            if (checkPipelineTableExists($pdo, 'spd_bppi')) {
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 4/6]: UPDATE ' . $tblBppi . ' (Angsuran BPPI)...');
                $sqlBppi = "
                    UPDATE `$tblBppi` a, (
                        SELECT a.ID, b.ID as STLGN_ID, a.TANGGAL,
                        IF((a.JUMLAH - a.AKUMBAYAR - a.DISKON) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR - a.DISKON) AS bayar,
                        (a.JUMLAH - a.AKUMBAYAR - a.DISKON) AS TOTAL_HUTANG, a.XANGSUR, a.XRANGSUR
                        FROM `$tblBppi` a
                        JOIN `$tblStlgn` b ON (b.ID = a.STLGN_ID OR b.NO_PDAM = a.NO_PDAM) 
                        JOIN `$tblRekening` c ON c.STLGN_ID = b.ID AND c.PERIODE = :cur_periode AND c.STATUS <> 'L'
                        WHERE a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.AKUMBAYAR < a.JUMLAH AND a.ANGPLAN > 0
                    ) b
                    SET a.AKUMBAYAR = a.AKUMBAYAR + b.bayar,
                        a.XRANGSUR = a.XRANGSUR + 1
                    WHERE a.ID = b.ID
                ";
                $stmtBppi = $pdo->prepare($sqlBppi);
                $stmtBppi->execute(['cur_periode' => $periodeBerjalan]);
                $jmlBppiUpdated = $stmtBppi->rowCount();
                $log("   - Update $tblBppi: $jmlBppiUpdated baris angsuran BPPI diperbarui.");
            } else {
                $log("   - Info: Tabel BPPI tidak ditemukan di database ini (dilewati).");
            }

            // E. Update PIDENDA (jika tabel ada)
            if (checkPipelineTableExists($pdo, 'spd_pidenda')) {
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 5/6]: UPDATE ' . $tblPidenda . ' (Piutang Denda)...');
                $sqlPidenda = "
                    UPDATE `$tblPidenda` a, (
                        SELECT a.ID, a.STLGN_ID, a.TANGGAL, 
                        IF((a.JUMLAH - a.AKUMBAYAR) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR) AS bayar,
                        (a.JUMLAH - a.AKUMBAYAR) AS TOTAL_HUTANG, a.XANGSUR, a.XRLANG
                        FROM `$tblPidenda` a
                        JOIN `$tblStlgn` b ON b.ID = a.STLGN_ID
                        JOIN `$tblRekening` c ON c.STLGN_ID = b.ID AND c.PERIODE = :cur_periode AND c.STATUS <> 'L'
                        WHERE a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.AKUMBAYAR < a.JUMLAH AND a.ANGPLAN > 0
                    ) b
                    SET a.AKUMBAYAR = a.AKUMBAYAR + b.bayar,
                        a.XRLANG = a.XRLANG + 1
                    WHERE a.ID = b.ID
                ";
                $stmtPidenda = $pdo->prepare($sqlPidenda);
                $stmtPidenda->execute(['cur_periode' => $periodeBerjalan]);
                $jmlPidendaUpdated = $stmtPidenda->rowCount();
                $log("   - Update $tblPidenda: $jmlPidendaUpdated baris angsuran denda diperbarui.");
            } else {
                $log("   - Info: Tabel PIDENDA tidak ditemukan di database ini (dilewati).");
            }

            // F. Memasukkan NON_AIR ke tabel SPD_REKENING periode baru ($nextPeriode)
            $unionParts = [];
            if (checkPipelineTableExists($pdo, 'spd_bppi')) {
                $unionParts[] = "
                    SELECT ifnull(a.STLGN_ID, b.ID) AS STLGN_ID, a.TANGGAL, 
                    IF((a.JUMLAH - a.AKUMBAYAR - a.DISKON) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR - a.DISKON) AS bayar,
                    (a.JUMLAH - a.AKUMBAYAR - a.DISKON) AS TOTAL_HUTANG, a.XANGSUR, a.XRANGSUR
                    FROM `$tblBppi` a
                    JOIN `$tblStlgn` b ON (b.ID = a.STLGN_ID OR b.NO_PDAM = a.NO_PDAM) 
                    JOIN `$tblRekening` c ON c.STLGN_ID = b.ID AND c.PERIODE = :cur_periode AND c.STATUS <> 'L'
                    WHERE a.AKUMBAYAR < a.JUMLAH AND a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.ANGPLAN > 0
                ";
            }
            if (checkPipelineTableExists($pdo, 'spd_pidenda')) {
                $unionParts[] = "
                    SELECT a.STLGN_ID, a.TANGGAL, 
                    IF((a.JUMLAH - a.AKUMBAYAR) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR) AS bayar,
                    (a.JUMLAH - a.AKUMBAYAR) AS TOTAL_HUTANG, a.XANGSUR, a.XRLANG
                    FROM `$tblPidenda` a
                    JOIN `$tblStlgn` b ON b.ID = a.STLGN_ID 
                    JOIN `$tblRekening` c ON c.STLGN_ID = b.ID AND c.PERIODE = :cur_periode AND c.STATUS <> 'L'
                    WHERE a.AKUMBAYAR < a.JUMLAH AND a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.ANGPLAN > 0
                ";
            }

            if (!empty($unionParts)) {
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi [Query 6/6]: UPDATE NON_AIR pada ' . $tblRekening . ' periode baru...');
                $unionSql = implode(" UNION ALL ", $unionParts);
                $sqlNonAir = "
                    UPDATE `$tblRekening` a, (
                        SELECT a.STLGN_ID, SUM(a.bayar) AS bayar, SUM(TOTAL_HUTANG) AS TOTAL_HUTANG, a.XANGSUR, a.XRANGSUR
                        FROM (
                            $unionSql
                        ) a
                        GROUP BY STLGN_ID
                    ) b 
                    SET a.NON_AIR = b.bayar 
                    WHERE a.STLGN_ID = b.STLGN_ID AND a.PERIODE = :next_periode
                ";
                $stmtNonAir = $pdo->prepare($sqlNonAir);
                $stmtNonAir->execute([
                    'cur_periode' => $periodeBerjalan,
                    'next_periode' => $nextPeriode
                ]);
                $jmlNonAirUpdated = $stmtNonAir->rowCount();
                $log("   - Update NON_AIR pada $tblRekening ($nextPeriode): $jmlNonAirUpdated rekening terupdate.");
            } else {
                $log("   - Update NON_AIR: Tidak ada tabel angsuran BPPI/PIDENDA (dilewati).");
            }

            // G. Insert ke tabel SPD_REKANG dari BPPI dan PIDENDA (Pengganti CALL insert_rekang agar bebas dari case-sensitivity bug stored procedure)
            $tblRekang = resolvePipelineTableName($pdo, 'spd_rekang');
            $lastDayNext = intval(date('t', strtotime("{$nextTahun}-{$nextBulan}-01")));
            $rekangParts = [];
            if (checkPipelineTableExists($pdo, 'spd_pidenda')) {
                $rekangParts[] = "
                    SELECT NULL, CONCAT('{$nextTahun}-{$nextBulan}-', LPAD(LEAST(DAY(a.TANGGAL), {$lastDayNext}), 2, '0')), a.STLGN_ID, a.NO_PDAM, b.LOKBAY_ID,
                    IF((a.JUMLAH - a.AKUMBAYAR) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR) as ANGPLAN, a.JUMLAH, a.AKUMBAYAR, a.XANGSUR, a.XRLANG, 'D', NULL, a.NOBUKTI, NULL, 0,
                    {$userId}, NULL, NULL, NOW(), NOW(), NULL
                    FROM `$tblPidenda` a
                    JOIN `$tblStlgn` b ON b.ID = a.STLGN_ID AND b.LAST_STATUS NOT IN ('F', 'R')
                    WHERE a.AKUMBAYAR < a.JUMLAH AND a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.ANGPLAN > 0
                ";
            }
            if (checkPipelineTableExists($pdo, 'spd_bppi')) {
                $rekangParts[] = "
                    SELECT NULL, CONCAT('{$nextTahun}-{$nextBulan}-', LPAD(LEAST(DAY(a.TANGGAL), {$lastDayNext}), 2, '0')), IFNULL(a.STLGN_ID, b.ID) as STLGN_ID, a.NO_PDAM, b.LOKBAY_ID,
                    IF((a.JUMLAH - a.AKUMBAYAR) >= a.ANGPLAN, a.ANGPLAN, a.JUMLAH - a.AKUMBAYAR) as REALISASI, a.JUMLAH, a.AKUMBAYAR, a.XANGSUR, a.XRANGSUR, 'B', NULL, a.KODE, NULL, 0,
                    {$userId}, NULL, NULL, NOW(), NOW(), NULL
                    FROM `$tblBppi` a
                    JOIN `$tblStlgn` b ON (b.ID = a.STLGN_ID OR b.NO_PDAM = a.NO_PDAM) AND b.LAST_STATUS NOT IN ('F', 'R')
                    WHERE a.IS_DELETE = 0 AND a.XANGSUR > 0 AND a.AKUMBAYAR < a.JUMLAH AND a.ANGPLAN > 0
                ";
            }

            if (!empty($rekangParts) && checkPipelineTableExists($pdo, 'spd_rekang')) {
                $rekangUnion = implode(" UNION ALL ", $rekangParts);
                $sqlInsertRekang = "INSERT INTO `$tblRekang` $rekangUnion";
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi INSERT INTO ' . $tblRekang . ' dari BPPI & PIDENDA...');
                $stmtInsertRekang = $pdo->prepare($sqlInsertRekang);
                $stmtInsertRekang->execute();
                $jmlRekang = $stmtInsertRekang->rowCount();
                $log("   - Insert ke $tblRekang dari BPPI & PIDENDA: $jmlRekang baris berhasil digenerate.");
            } else {
                $tglAkhirBulan = "{$nextTahun}-{$nextBulan}-{$lastDayNext}";
                try {
                    $pdo->exec("CALL insert_rekang('{$tglAkhirBulan}', NULL, '{$periodeBerjalan}')");
                    $log("   - Procedure insert_rekang berhasil dieksekusi.");
                } catch (Exception $eProc) {
                    $log("   - Info: Lewati procedure insert_rekang ({$eProc->getMessage()}).");
                }
            }

            // H. Update SPD_REKENING periode sebelumnya: Merubah IS_TUTUPMETER menjadi 1
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Mengeksekusi UPDATE spd_rekening SET IS_TUTUPMETER = 1...');
            $stmtTutupMeter = $pdo->prepare("UPDATE spd_rekening SET IS_TUTUPMETER = 1 WHERE PERIODE = :cur_periode");
            $stmtTutupMeter->execute(['cur_periode' => $periodeBerjalan]);
            $jmlTutupMeter = $stmtTutupMeter->rowCount();
            $log("   - Update IS_TUTUPMETER = 1 pada spd_rekening ($periodeBerjalan): $jmlTutupMeter baris.");

            // I. Hitung Rekapitulasi Akhir
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'RUNNING', $t2_start, null, 'Menghitung rekapitulasi akhir transaksi closing rekening...');
            $stmtRekap = $pdo->prepare("
                SELECT 
                    COUNT(STLGN_ID) as jml_pelanggan,
                    COALESCE(SUM(AIR), 0) as air,
                    COALESCE(SUM(NON_AIR), 0) as non_air,
                    COALESCE(SUM(PEMELIHARAAN), 0) as pemel,
                    COALESCE(SUM(ADMINISTRASI), 0) as admin,
                    COALESCE(SUM(CASE WHEN MATERAI = 10000 THEN 1 ELSE 0 END), 0) as pelmat,
                    COALESCE(SUM(CASE WHEN MATERAI = 10000 THEN MATERAI ELSE 0 END), 0) as totmaterai
                FROM spd_rekening
                WHERE PERIODE = :cur_periode AND STATUS IN ('A','T')
            ");
            $stmtRekap->execute(['cur_periode' => $periodeBerjalan]);
            $rekapData = $stmtRekap->fetch(PDO::FETCH_ASSOC);

            // Selesai Transaksi
            $pdo->commit();

            $t2_end = date('Y-m-d H:i:s');
            $jmlPelanggan = number_format((float)($rekapData['jml_pelanggan'] ?? 0), 0, ',', '.');
            $totalAir = number_format((float)($rekapData['air'] ?? 0), 0, ',', '.');
            $pesanStep2 = "Closing rekening periode $periodeBerjalan sukses. {$jmlPelanggan} pelanggan, Total Air: Rp {$totalAir}. Periode baru $nextPeriode berhasil dibuka.";
            $log("✓ $step2Name berhasil. $pesanStep2");
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 2, $step2Name, 'SUCCESS', $t2_start, $t2_end, $pesanStep2, $rekapData);
            $pipelineResult['steps'][2] = [
                'name' => $step2Name,
                'status' => 'SUCCESS',
                'pesan' => $pesanStep2,
                'data' => $rekapData
            ];

        } catch (Exception $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw new Exception("Gagal pada $step2Name: " . $e->getMessage());
        }
        } // End if        // -------------------------------------------------------------
        // TAHAP 3: TRANSAKSI TRANSFER PPOB & HANKAM
        // -------------------------------------------------------------
        if ($resumeStep <= 3) {
            $step3Name = "Tahap 3: Transaksi Transfer Tagihan ke PPOB";
            $log("\n>>> Menjalankan $step3Name...");
            $t3_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'RUNNING', $t3_start);

            // Pastikan sql_mode relaxed agar tidak gagal jika ada data string lama yang melebihi batas kolom tabel pdam legacy
            try {
                $pdo->exec("SET SESSION sql_mode = ''");
            } catch (Exception $e) {}

            $pdo->beginTransaction();

            try {
                // 1. TRUNCATE tabel pdam.ppob
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'RUNNING', $t3_start, null, 'Mengeksekusi [Query 1/4]: TRUNCATE pdam.ppob...');
                $pdo->exec("TRUNCATE `pdam`.`ppob`");
                $log("   - TRUNCATE `pdam`.`ppob` berhasil.");

                // 2. Insert Tagihan Berjalan ke pdam.ppob
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'RUNNING', $t3_start, null, 'Mengeksekusi [Query 2/4]: INSERT INTO pdam.ppob (Tagihan Rekening Aktif ' . $periodeBerjalan . ')...');
                $sqlPpobTagihan = "
                    INSERT INTO `pdam`.ppob
                    SELECT a.NO_PDAM, LEFT(b.NAMA, 30) AS NAMA, LEFT(b.ALAMAT, 50) AS ALAMAT, LEFT(concat(c.KETERANGAN, ' (', a.STGOL_ID, ')'), 40) AS GOL,
                    IF(a.EDITMETER = 0, a.METER, a.EDITMETER) AS MTRINI, a.METERLALU, a.VOLUME_TAGIHAN AS PAKAI, (a.RK + a.MATERAI) AS TAGAIR, a.NON_AIR AS TAGNONAIR,
                    IFNULL(concat('(', d.XANGSUR, '/', d.XRLANG, ')'), 0) AS ANGS_KE, 0 AS DENDA, a.SUBSIDI AS SUBSIDI, (a.RK + a.NON_AIR + a.MATERAI - a.SUBSIDI) AS TOTTAG, 
                    :blntag AS BLNTAG, 
                    concat(1, '.', a.NO_PDAM, '.', a.PERIODE, '.', left((a.RK + a.NON_AIR + a.MATERAI), 4)) AS NOSERIAL,
                    NULL AS TGL_LUNAS, NULL AS TIME_LUNAS, 1 AS REK, 0 AS FLAG,
                    0 AS TRANSFER, a.LOKBAY_ID AS LOKBYR, 0 AS AKTIF
                    FROM spd_rekening a
                    JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                    JOIN spd_stgol c ON c.ID = a.STGOL_ID
                    LEFT JOIN (
                        SELECT a.STLGN_ID, MAX(a.XANGSUR) AS XANGSUR, MAX(a.XRLANG + 1) AS XRLANG 
                        FROM spd_rekang a
                        WHERE date_format(a.TANGGAL, '%Y%m') = :periode_tagihan AND a.XANGSUR > 0
                        GROUP BY a.STLGN_ID
                    ) d ON d.STLGN_ID = a.STLGN_ID
                    JOIN spd_lokbay e ON e.ID = a.LOKBAY_ID
                    WHERE a.PERIODE = :periode_tagihan AND a.`STATUS` NOT IN ('L') AND e.PPOB = 3 AND a.FLAG = 0
                ";
                $stmtPpobTag = $pdo->prepare($sqlPpobTagihan);
                $stmtPpobTag->execute([
                    'blntag' => $nextPeriode,
                    'periode_tagihan' => $periodeBerjalan
                ]);
                $jmlPpobTagihan = $stmtPpobTag->rowCount();
                $log("   - Insert Tagihan Rekening ke `pdam`.`ppob`: $jmlPpobTagihan baris.");

                // 3. Insert Tunggakan ke pdam.ppob
                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'RUNNING', $t3_start, null, 'Mengeksekusi [Query 3/4]: INSERT INTO pdam.ppob (Tunggakan Rekening)...');
                $sqlPpobTunggakan = "
                    INSERT INTO `pdam`.ppob
                    SELECT a.NO_PDAM, LEFT(b.NAMA, 30) AS NAMA, LEFT(b.ALAMAT, 50) AS ALAMAT,
                    LEFT(concat(c.KETERANGAN, ' (', a.STGOL_ID, ')'), 40) AS GOL,
                    ifnull(d.MTRINI, 0) AS MTRINI, ifnull(d.METERLALU, 0) AS METERLALU, ifnull(d.PAKAI, 0) AS PAKAI,
                    (a.AIR + a.MATERAI) AS TAGAIR, a.NON_AIR AS TAGNONAIR,
                    ifnull(concat('(', e.XANGSUR, '/', e.XRLANG, ')'), '') AS ANGS_KE, a.DENDA AS DENDA, a.SUBSIDI AS SUBSIDI, (a.JUMLAH - a.SUBSIDI) AS TOTTAG,
                    date_format(date_sub(a.REKENING_BULAN, INTERVAL -1 MONTH), '%Y%m') AS BLNTAG, 
                    concat(if(a.IS_YKK=1, 3, 2), '.', a.NO_PDAM, '.', date_format(a.REKENING_BULAN, '%Y%m'), '.', left(a.JUMLAH, 4)) AS NOSERIAL,
                    NULL AS TGL_LUNAS, NULL AS TIME_LUNAS, if(a.IS_YKK=1, 3, 2) AS REK, 0 AS FLAG,
                    0 AS TRANSFER, a.LOKBAY_ID AS LOKBYR, if(f.STATUS IN ('L'), 2, 0) AS AKTIF
                    FROM spd_tunggak a
                    JOIN spd_stlgn b ON b.ID = a.STLGN_ID
                    JOIN spd_stgol c ON c.ID = a.STGOL_ID
                    LEFT JOIN (
                        SELECT a.STLGN_ID, a.PERIODE, ifnull(a.EDITMETER, a.METER) AS MTRINI, a.METERLALU, a.VOLUME_TAGIHAN AS PAKAI
                        FROM spd_rekening a
                    ) d ON d.STLGN_ID = a.STLGN_ID AND d.PERIODE = date_format(a.REKENING_BULAN, '%Y%m')
                    LEFT JOIN (
                        SELECT a.STLGN_ID, MAX(a.XANGSUR) AS XANGSUR, MAX(a.XRLANG + 1) AS XRLANG, date_format(a.TANGGAL, '%Y%m') AS PERIODE
                        FROM spd_rekang a
                        WHERE a.XANGSUR > 0
                        GROUP BY a.STLGN_ID, date_format(a.TANGGAL, '%Y%m')
                    ) e ON e.STLGN_ID = a.STLGN_ID AND e.PERIODE = date_format(a.REKENING_BULAN, '%Y%m')
                    LEFT JOIN (
                        SELECT a.STLGN_ID, a.STATUS 
                        FROM spd_rekening a 
                        WHERE a.PERIODE = :periode_tagihan
                    ) f ON f.STLGN_ID = a.STLGN_ID
                    JOIN spd_lokbay g ON g.ID = b.LOKBAY_ID
                    WHERE a.LUNAS = 0 AND g.PPOB = 3 AND a.IS_DELETE = 0 AND a.PH IS NULL
                    GROUP BY a.REKENING_BULAN, a.STLGN_ID
                    ORDER BY a.REKENING_BULAN
                ";
                $stmtPpobTung = $pdo->prepare($sqlPpobTunggakan);
                $stmtPpobTung->execute(['periode_tagihan' => $periodeBerjalan]);
                $jmlPpobTunggakan = $stmtPpobTung->rowCount();
                $log("   - Insert Tunggakan ke `pdam`.`ppob`: $jmlPpobTunggakan baris.");

                // 4. Update Hankam
                $stmtDelHankam = $pdo->prepare("DELETE FROM `pdam`.`hankam` WHERE PERIODE = :periode_tagihan");
                $stmtDelHankam->execute(['periode_tagihan' => $periodeBerjalan]);

                // Hankam LOKBAY_ID = 'A'
                $sqlHankamA = "
                    INSERT INTO `pdam`.hankam (
                        MATRA_KESATUAN, NAMA_SATKER, NOSAMB, NAMA, ALAMAT, KODE_GOL, GOLONGAN, PERIODE,
                        STAN_LALU, STAN_KINI, STAN_ANGKAT, PAKAI, TAGIHAN, ADMINISTRASI, PEMELIHARAAN,
                        MATERAI, ANGSURAN, TOTAL_TAGIHAN 
                    ) SELECT
                        d.LOKASI, e.KETERANGAN, b.NO_PDAM, LEFT(b.NAMA, 40), LEFT(b.ALAMAT, 50), b.STGOL_ID, g.KETERANGAN, c.PERIODE,
                        c.METERLALU, c.METER, c.EDITMETER, c.VOLUME_TAGIHAN, c.AIR, c.ADMINISTRASI, c.PEMELIHARAAN,
                        c.MATERAI, c.NON_AIR, ( c.AIR + c.ADMINISTRASI + c.PEMELIHARAAN + c.MATERAI + c.NON_AIR ) 
                    FROM spd_rekening c
                    JOIN spd_stlgn b ON b.ID = c.STLGN_ID
                    JOIN spd_lokbay d ON d.ID = c.LOKBAY_ID
                    JOIN spd_stsatker e ON e.LOKBAY_ID = c.LOKBAY_ID
                    JOIN spd_tksatker f ON f.STSATKER_ID = e.ID AND f.STLGN_ID = b.ID
                    JOIN spd_stgol g ON g.ID = c.STGOL_ID 
                    WHERE c.PERIODE = :periode_tagihan AND c.LOKBAY_ID = 'A' AND c.STATUS != 'L'
                ";
                $stmtHA = $pdo->prepare($sqlHankamA);
                $stmtHA->execute(['periode_tagihan' => $periodeBerjalan]);
                $jmlHA = $stmtHA->rowCount();

                // Hankam LOKBAY_ID = 'M' (AKMIL)
                $sqlHankamM = "
                    INSERT INTO `pdam`.hankam (
                        MATRA_KESATUAN, NAMA_SATKER, NOSAMB, NAMA, ALAMAT, KODE_GOL, GOLONGAN, PERIODE,
                        STAN_LALU, STAN_KINI, STAN_ANGKAT, PAKAI, TAGIHAN, ADMINISTRASI, PEMELIHARAAN,
                        MATERAI, ANGSURAN, TOTAL_TAGIHAN 
                    ) SELECT
                        d.LOKASI, 'AKMIL', b.NO_PDAM, LEFT(b.NAMA, 40), LEFT(b.ALAMAT, 50), b.STGOL_ID, g.KETERANGAN, c.PERIODE,
                        c.METERLALU, c.METER, c.EDITMETER, c.VOLUME_TAGIHAN, c.AIR, c.ADMINISTRASI, c.PEMELIHARAAN,
                        c.MATERAI, c.NON_AIR, ( c.AIR + c.ADMINISTRASI + c.PEMELIHARAAN + c.MATERAI + c.NON_AIR ) 
                    FROM spd_rekening c
                    JOIN spd_stlgn b ON b.ID = c.STLGN_ID
                    JOIN spd_lokbay d ON d.ID = c.LOKBAY_ID
                    JOIN spd_stgol g ON g.ID = c.STGOL_ID 
                    WHERE c.PERIODE = :periode_tagihan AND c.LOKBAY_ID = 'M' AND c.STATUS != 'L'
                ";
                $stmtHM = $pdo->prepare($sqlHankamM);
                $stmtHM->execute(['periode_tagihan' => $periodeBerjalan]);
                $jmlHM = $stmtHM->rowCount();

                // Hankam LOKBAY_ID = 'MA'
                $sqlHankamMA = "
                    INSERT INTO `pdam`.hankam (
                        MATRA_KESATUAN, NAMA_SATKER, NOSAMB, NAMA, ALAMAT, KODE_GOL, GOLONGAN, PERIODE,
                        STAN_LALU, STAN_KINI, STAN_ANGKAT, PAKAI, TAGIHAN, ADMINISTRASI, PEMELIHARAAN,
                        MATERAI, ANGSURAN, TOTAL_TAGIHAN 
                    ) SELECT
                        d.LOKASI, e.KETERANGAN, b.NO_PDAM, LEFT(b.NAMA, 40), LEFT(b.ALAMAT, 50), b.STGOL_ID, g.KETERANGAN, c.PERIODE,
                        c.METERLALU, c.METER, c.EDITMETER, c.VOLUME_TAGIHAN, c.AIR, c.ADMINISTRASI, c.PEMELIHARAAN,
                        c.MATERAI, c.NON_AIR, ( c.AIR + c.ADMINISTRASI + c.PEMELIHARAAN + c.MATERAI + c.NON_AIR ) 
                    FROM spd_rekening c
                    JOIN spd_stlgn b ON b.ID = c.STLGN_ID
                    JOIN spd_lokbay d ON d.ID = c.LOKBAY_ID
                    JOIN spd_stsatker e ON e.LOKBAY_ID = c.LOKBAY_ID
                    JOIN spd_tksatker f ON f.STSATKER_ID = e.ID AND f.STLGN_ID = b.ID
                    JOIN spd_stgol g ON g.ID = c.STGOL_ID 
                    WHERE c.PERIODE = :periode_tagihan AND c.LOKBAY_ID = 'MA' AND c.STATUS != 'L'
                ";
                $stmtHMA = $pdo->prepare($sqlHankamMA);
                $stmtHMA->execute(['periode_tagihan' => $periodeBerjalan]);
                $jmlHMA = $stmtHMA->rowCount();

                $totalHankam = $jmlHA + $jmlHM + $jmlHMA;
                $log("   - Insert HANKAM (A: $jmlHA, M: $jmlHM, MA: $jmlHMA): Total $totalHankam baris.");

                $pdo->commit();

                $t3_end = date('Y-m-d H:i:s');
                $pesanStep3 = "Transfer PPOB & Hankam berhasil. Tagihan Berjalan: $jmlPpobTagihan, Tunggakan: $jmlPpobTunggakan, Hankam: $totalHankam.";
                $log("✓ $step3Name berhasil. $pesanStep3");

                $ppobSummary = [
                    'tagihan_berjalan' => $jmlPpobTagihan,
                    'tunggakan' => $jmlPpobTunggakan,
                    'hankam_a' => $jmlHA,
                    'hankam_m' => $jmlHM,
                    'hankam_ma' => $jmlHMA,
                    'total_hankam' => $totalHankam
                ];

                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 3, $step3Name, 'SUCCESS', $t3_start, $t3_end, $pesanStep3, $ppobSummary);
                $pipelineResult['steps'][3] = [
                    'name' => $step3Name,
                    'status' => 'SUCCESS',
                    'pesan' => $pesanStep3,
                    'data' => $ppobSummary
                ];

            } catch (Exception $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw new Exception("Gagal pada $step3Name: " . $e->getMessage());
            }
        } // End if resumeStep <= 3

        // -------------------------------------------------------------
        // TAHAP 4: PELUNASAN RUMAH IBADAH
        // -------------------------------------------------------------
        if ($resumeStep <= 4) {
            $step4Name = "Tahap 4: Pelunasan Rekening Rumah Ibadah";
            $log("\n>>> Menjalankan $step4Name...");
            $t4_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 4, $step4Name, 'RUNNING', $t4_start, null, 'Mengeksekusi UPDATE pdam.ppob SET FLAG = 9 (Pelunasan Rumah Ibadah)...');

            try {
                $sqlRumahIbadah = "
                    UPDATE `pdam`.`ppob`
                    SET `FLAG` = 9,
                        `TGL_LUNAS` = IFNULL(`TGL_LUNAS`, CURDATE()),
                        `TIME_LUNAS` = IFNULL(`TIME_LUNAS`, CURTIME())
                    WHERE `REK` = 1
                      AND `FLAG` != 9
                      AND (
                          (
                              `GOL` IN (
                                  'Gereja,Langgar,Pura,Kelenteng (IB3)',
                                  'Masjid Jamik (IB1)',
                                  'Masjid kecil (IB2)'
                              )
                              AND (
                                  `IDLGN` LIKE '1%' 
                                  OR `IDLGN` LIKE '2%' 
                                  OR `IDLGN` LIKE '3%'
                              )
                          )
                          OR `IDLGN` = '12010151'
                      )
                ";
                $stmtRumahIbadah = $pdo->prepare($sqlRumahIbadah);
                $stmtRumahIbadah->execute();
                $jmlRumahIbadah = $stmtRumahIbadah->rowCount();
                $log("   - Update FLAG = 9 pada `pdam`.`ppob`: $jmlRumahIbadah rekening rumah ibadah dilunaskan.");

                $t4_end = date('Y-m-d H:i:s');
                $pesanStep4 = "Pelunasan rekening rumah ibadah berhasil. $jmlRumahIbadah rekening diset FLAG = 9 (Lunas).";
                $log("✓ $step4Name berhasil. $pesanStep4");

                $ibadahSummary = [
                    'jumlah_rekening_dilunaskan' => $jmlRumahIbadah,
                    'kriteria' => 'REK=1, GOL IB1/IB2/IB3 (IDLGN 1,2,3) + IDLGN 12010151',
                    'flag_result' => 9
                ];

                recordPipelineStep($pdo, $batchId, $periodeBerjalan, 4, $step4Name, 'SUCCESS', $t4_start, $t4_end, $pesanStep4, $ibadahSummary);
                $pipelineResult['steps'][4] = [
                    'name' => $step4Name,
                    'status' => 'SUCCESS',
                    'pesan' => $pesanStep4,
                    'data' => $ibadahSummary
                ];

            } catch (Exception $e) {
                if (strpos($e->getMessage(), '1062 Duplicate entry') !== false) {
                    $log("   - [INFO] Pelunasan Rumah Ibadah sudah pernah tercatat sebelumnya (Idempotent).");
                    $t4_end = date('Y-m-d H:i:s');
                    $pesanStep4 = "Pelunasan rekening rumah ibadah telah selesai tercatat sebelumnya.";
                    recordPipelineStep($pdo, $batchId, $periodeBerjalan, 4, $step4Name, 'SUCCESS', $t4_start, $t4_end, $pesanStep4);
                    $pipelineResult['steps'][4] = [
                        'name' => $step4Name,
                        'status' => 'SUCCESS',
                        'pesan' => $pesanStep4
                    ];
                } else {
                    throw new Exception("Gagal pada $step4Name: " . $e->getMessage());
                }
            }
        } // End if resumeStep <= 4

        // -------------------------------------------------------------
        // TAHAP 5: SET INFO OFFLINE = '1' (MODE ONLINE KEMBALI)
        // -------------------------------------------------------------
        if ($resumeStep <= 5) {
            $step5Name = "Tahap 5: Set Status Mode Online Kembali (OFFLINE = '1')";
            $log("\n>>> Menjalankan $step5Name...");
            $t5_start = date('Y-m-d H:i:s');
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 5, $step5Name, 'RUNNING', $t5_start);

            $pdo->exec("UPDATE `pdam`.`info` SET `OFFLINE` = '1'");
            $t5_end = date('Y-m-d H:i:s');
            $log("✓ $step5Name berhasil. Sistem PPOB diset kembali online (aktif).");

            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 5, $step5Name, 'SUCCESS', $t5_start, $t5_end, 'OFFLINE = 1');
            $pipelineResult['steps'][5] = ['name' => $step5Name, 'status' => 'SUCCESS', 'pesan' => 'OFFLINE diset 1'];
        }

        // Selesai dengan sukses penuh
        $pipelineResult['success'] = true;
        $endTimeAll = microtime(true);
        $totalDurasi = round($endTimeAll - $startTimeAll, 2);
        $pipelineResult['durasi_total_detik'] = $totalDurasi;
        $pipelineResult['waktu_selesai'] = date('Y-m-d H:i:s');

        $log("\n====================================================================");
        $log("PIPELINE CLOSING REKENING SELESAI DENGAN SUKSES! (Total Durasi: {$totalDurasi} detik)");
        $log("====================================================================");

    } catch (Exception $e) {
        $endTimeAll = microtime(true);
        $totalDurasi = round($endTimeAll - $startTimeAll, 2);
        $pipelineResult['success'] = false;
        $pipelineResult['error'] = $e->getMessage();
        $pipelineResult['durasi_total_detik'] = $totalDurasi;
        $pipelineResult['waktu_selesai'] = date('Y-m-d H:i:s');

        $log("\n[FATAL ERROR] PIPELINE CLOSING REKENING DIHENTIKAN: " . $e->getMessage());

        if ($pdo && isset($periodeBerjalan)) {
            try {
                $stmtFail = $pdo->prepare("UPDATE pipeline_log SET status = 'FAILED', waktu_selesai = NOW(), pesan = :pesan WHERE batch_id = :bid AND status = 'RUNNING'");
                $stmtFail->execute(['pesan' => $e->getMessage(), 'bid' => $batchId]);
            } catch (Exception $ex) {}
            recordPipelineStep($pdo, $batchId, $periodeBerjalan, 99, "Pipeline Error", 'FAILED', date('Y-m-d H:i:s'), date('Y-m-d H:i:s'), $e->getMessage());
        }
    }

    return $pipelineResult;
}

// Jika dijalankan langsung via CLI
if (php_sapi_name() === 'cli' && isset($argv[0]) && basename($argv[0]) === basename(__FILE__)) {
    executeMasterPipeline(['executed_by' => 'CLI_RUNNER']);
}
