<?php
$env = parse_ini_file('.env');
echo "=== TES KONEKSI DATABASE ===\n";
echo "Host: " . ($env['DB_HOST'] ?? 'localhost') . "\n";
echo "DB:   " . ($env['DB_NAME'] ?? 'simpadu') . "\n";
echo "User: " . ($env['DB_USER'] ?? 'root') . "\n";

try {
    $pdo = new PDO(
        "mysql:host={$env['DB_HOST']};port={$env['PORT']};dbname={$env['DB_NAME']};charset=utf8mb4",
        $env['DB_USER'],
        $env['DB_PASS'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $periode = '202608';
    $tanggalLike = '2026-09';
    $start = microtime(true);
    
    echo "1. Membangun tabel eliminasi in-memory...\n";
    $pdo->exec("
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_eliminasi (
            no_pdam VARCHAR(30) CHARACTER SET utf8 COLLATE utf8_general_ci PRIMARY KEY,
            alasan VARCHAR(30)
        ) ENGINE=MEMORY;
        TRUNCATE TABLE tmp_eliminasi;
    ");

    $pdo->exec("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Tunggakan' FROM spd_tunggak c 
        WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P');
    ");

    $pdo->exec("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Penertiban' FROM spd_bon d 
        WHERE d.TANGGAL LIKE '{$tanggalLike}-%' AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0';
    ");

    $pdo->exec("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Realisasi' FROM spd_realmohon e 
        WHERE e.TANGGAL LIKE '{$tanggalLike}%' AND e.STPLYN_ID LIKE 't%';
    ");

    $pdo->exec("
        INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
        SELECT no_pdam, 'Subsidi' FROM spd_rekening f 
        WHERE f.subsidi != 0 AND f.FLAG = '0';
    ");
    echo "   -> Tabel eliminasi siap dalam " . round(microtime(true) - $start, 2) . "s\n";

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
    echo "2. Kueri Rencana Beli: " . count($resBeli) . " data (" . round(microtime(true) - $sBeli, 2) . "s)\n";

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
    echo "3. Kueri Rencana Batal: " . count($resBatal) . " data (" . round(microtime(true) - $sBatal, 2) . "s)\n";
    if (count($resBatal) > 0) {
        echo "   Contoh alasan: " . $resBatal[0]['ALASAN'] . " (" . $resBatal[0]['NAMA'] . ")\n";
    }
    exit;








    
    $periode = '202608';
    $tanggalLike = '2026-09';
    echo "1. Menguji base query (tanpa NOT IN subqueries) untuk periode $periode...\n";
    $start = microtime(true);
    $start = microtime(true);
    $query = "
        SELECT a.NO_PDAM, b.NAMA, a.PERIODE, a.LOKBAY_ID, a.STGOL_ID, a.RK, a.NON_AIR
        FROM spd_rekening a 
        JOIN spd_stlgn b ON b.ID = a.STLGN_ID
        WHERE 
            a.PERIODE = :periode 
            AND a.STATUS = 'a' 
            AND a.FLAG = '0' 
            AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
            AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND b.nama NOT LIKE '%rumdis%' 
            AND b.nama NOT LIKE '%rumdin%' 
            AND b.nama NOT LIKE '%rusus%'
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_tunggak c 
                WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_bon d 
                WHERE d.TANGGAL LIKE CONCAT(:tanggal_like, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_realmohon e 
                WHERE e.TANGGAL LIKE CONCAT(:tanggal_like, '%') AND e.STPLYN_ID LIKE 't%'
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_rekening f 
                WHERE f.subsidi != 0 AND f.FLAG = '0'
            )
    ";
    echo "3. Menjalankan kueri gabungan lengkap...\n";
    $stmt = $pdo->prepare($query);
    $stmt->execute(['periode' => $periode, 'tanggal_like' => $tanggalLike]);
    $data = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $dur = round(microtime(true) - $start, 2);
    echo "   -> Kueri gabungan BERHASIL dalam {$dur}s! Jumlah baris data: " . count($data) . "\n";
    exit;









    $periode = '202608';
    $tanggalLike = '2026-09';

    echo "\n--- HASIL KUERI LENGKAP DENGAN PERIODE $periode & TANGGAL $tanggalLike ---\n";
    // 1. Kueri Beli
    $queryBeli = "
        SELECT a.NO_PDAM, b.NAMA, a.PERIODE, a.LOKBAY_ID, a.STGOL_ID, a.RK, a.NON_AIR
        FROM spd_rekening a 
        JOIN spd_stlgn b ON b.ID = a.STLGN_ID
        WHERE 
            a.PERIODE = :periode 
            AND a.STATUS = 'a' 
            AND a.FLAG = '0' 
            AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
            AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND b.nama NOT LIKE '%rumdis%' 
            AND b.nama NOT LIKE '%rumdin%' 
            AND b.nama NOT LIKE '%rusus%'
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_tunggak c 
                WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_bon d 
                WHERE d.TANGGAL LIKE CONCAT(:tanggal_like, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_realmohon e 
                WHERE e.TANGGAL LIKE CONCAT(:tanggal_like, '%') AND e.STPLYN_ID LIKE 't%'
            )
            AND a.no_pdam NOT IN (
                SELECT no_pdam FROM spd_rekening f 
                WHERE f.subsidi != 0 AND f.FLAG = '0'
            )
    ";
    $stmt = $pdo->prepare($queryBeli);
    $stmt->execute(['periode' => $periode, 'tanggal_like' => $tanggalLike]);
    $rowsBeli = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo "1. Rencana Beli: " . count($rowsBeli) . " data ditemukan.\n";
    if (count($rowsBeli) > 0) {
        echo "   Contoh data pertama: NO_PDAM: {$rowsBeli[0]['NO_PDAM']} | NAMA: {$rowsBeli[0]['NAMA']}\n";
    }



    // 2. Tes Rencana Pembatalan
    echo "Menjalankan kueri Rencana Batal... ";
    $startTime = microtime(true);
    $queryBatal = "
        SELECT COUNT(*) as total_batal, SUM(RK + NON_AIR) as total_nominal
        FROM spd_rekening a 
        JOIN spd_stlgn b ON b.ID = a.STLGN_ID
        WHERE 
            a.PERIODE = :periode 
            AND a.STATUS != 'l' 
            AND a.FLAG = '0' 
            AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
            AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND (
                a.STATUS != 'a'
                OR (b.nama LIKE '%rumdis%' OR b.nama LIKE '%rumdin%' OR b.nama LIKE '%rusus%')
                OR a.no_pdam IN (
                    SELECT no_pdam FROM spd_tunggak c 
                    WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
                )
                OR a.no_pdam IN (
                    SELECT no_pdam FROM spd_bon d 
                    WHERE d.TANGGAL LIKE CONCAT(:tanggal_like, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
                )
                OR a.no_pdam IN (
                    SELECT no_pdam FROM spd_realmohon e 
                    WHERE e.TANGGAL LIKE CONCAT(:tanggal_like, '%') AND e.STPLYN_ID LIKE 't%'
                )
                OR a.no_pdam IN (
                    SELECT no_pdam FROM spd_rekening f 
                    WHERE f.subsidi != 0 AND f.FLAG = '0'
                )
            )
    ";
    $stmt = $pdo->prepare($queryBatal);
    $stmt->execute(['periode' => $periode, 'tanggal_like' => $tanggalLike]);
    $resBatal = $stmt->fetch(PDO::FETCH_ASSOC);
    $durBatal = round(microtime(true) - $startTime, 2);
    echo "OK ({$durBatal}s)\n";
    echo "  -> Total Pelanggan Batal: " . number_format($resBatal['total_batal']) . "\n";
    echo "  -> Total Nominal Batal: Rp " . number_format($resBatal['total_nominal'] ?? 0, 0, ',', '.') . "\n";


} catch (Exception $e) {
    echo "Koneksi GAGAL: " . $e->getMessage() . "\n";
}

