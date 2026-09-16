<?php
$envFile = __DIR__ . '/.env';
$env = file_exists($envFile) ? parse_ini_file($envFile) : [];
$host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
$db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : '';
$port = !empty($env['PORT']) ? $env['PORT'] : '3306';

echo "=== TES OPTIMASI KUERI DATABASE ===\n";
echo "Host: $host | DB: $db | User: $user\n\n";

try {
    $pdo = new PDO(
        "mysql:host=$host;port=$port;dbname=$db;charset=utf8mb4",
        $user,
        $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $periode = '202512';
    $year = intval(substr($periode, 0, 4));
    $month = intval(substr($periode, 4, 2)) + 1;
    if ($month > 12) { $month = 1; $year++; }
    $tanggalLike = sprintf("%04d-%02d", $year, $month);

    echo "Periode: $periode | Tanggal Like: $tanggalLike\n";
    $startTotal = microtime(true);

    echo "1. Membangun tabel in-memory (tmp_eliminasi)...\n";
    $pdo->exec("
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_eliminasi (
            no_pdam VARCHAR(10) CHARACTER SET utf8 COLLATE utf8_general_ci PRIMARY KEY,
            alasan VARCHAR(20)
        ) ENGINE=MEMORY;
        TRUNCATE TABLE tmp_eliminasi;
    ");

    $t1 = microtime(true);
    $pdo->exec("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Tunggakan' FROM spd_tunggak c 
        WHERE c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0 AND (c.PH IS NULL OR c.PH != 'P');
    ");
    $t2 = microtime(true);
    echo "   -> Tunggakan : " . round($t2 - $t1, 3) . "s\n";

    $stmtBon = $pdo->prepare("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Penertiban' FROM spd_bon d 
        WHERE d.TANGGAL LIKE CONCAT(:tgl, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0';
    ");
    $stmtBon->execute(['tgl' => $tanggalLike]);
    $t3 = microtime(true);
    echo "   -> Penertiban: " . round($t3 - $t2, 3) . "s\n";

    $stmtReal = $pdo->prepare("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Realisasi' FROM spd_realmohon e 
        WHERE e.TANGGAL LIKE CONCAT(:tgl, '%') AND e.STPLYN_ID LIKE 't%';
    ");
    $stmtReal->execute(['tgl' => $tanggalLike]);
    $t4 = microtime(true);
    echo "   -> Realisasi : " . round($t4 - $t3, 3) . "s\n";

    $stmtSub = $pdo->prepare("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Subsidi' FROM spd_rekening f 
        WHERE f.PERIODE = :periode AND f.subsidi != 0 AND f.FLAG = '0';
    ");
    $stmtSub->execute(['periode' => $periode]);
    $t5 = microtime(true);
    echo "   -> Subsidi   : " . round($t5 - $t4, 3) . "s (Optimized with PERIODE)\n";

    // Tes Beli
    $sBeli = microtime(true);
    $qBeli = "
        SELECT a.NO_PDAM, b.NAMA, a.PERIODE, a.LOKBAY_ID, a.STGOL_ID, a.RK, a.NON_AIR
        FROM spd_rekening a 
        JOIN spd_stlgn b ON b.ID = a.STLGN_ID
        LEFT JOIN tmp_eliminasi x ON x.no_pdam = a.no_pdam
        WHERE 
            a.PERIODE = :periode 
            AND a.STATUS = 'a' 
            AND a.FLAG = '0' 
            AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
            AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND b.nama NOT LIKE '%rumdis%' 
            AND b.nama NOT LIKE '%rumdin%' 
            AND b.nama NOT LIKE '%rusus%'
            AND x.no_pdam IS NULL
    ";
    $stmt = $pdo->prepare($qBeli);
    $stmt->execute(['periode' => $periode]);
    $resBeli = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo "\n2. Kueri Rencana Beli: " . count($resBeli) . " data (" . round(microtime(true) - $sBeli, 3) . "s)\n";

    // Tes Batal
    $sBatal = microtime(true);
    $qBatal = "
        SELECT a.NO_PDAM, b.NAMA, a.PERIODE, a.LOKBAY_ID, a.STGOL_ID, a.RK, a.NON_AIR,
        CASE
            WHEN a.STATUS != 'a' THEN CONCAT('Status ', UPPER(a.STATUS))
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
            AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND (
                a.STATUS != 'a'
                OR (b.nama LIKE '%rumdis%' OR b.nama LIKE '%rumdin%' OR b.nama LIKE '%rusus%')
                OR x.no_pdam IS NOT NULL
            )
    ";
    $stmt = $pdo->prepare($qBatal);
    $stmt->execute(['periode' => $periode]);
    $resBatal = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo "3. Kueri Rencana Batal: " . count($resBatal) . " data (" . round(microtime(true) - $sBatal, 3) . "s)\n";

    $totalTime = round(microtime(true) - $startTotal, 3);
    echo "\n=== TOTAL WAKTU EKSEKUSI PIPELINE: {$totalTime}s ===\n";

} catch (Exception $e) {
    echo "ERROR: " . $e->getMessage() . "\n";
}
