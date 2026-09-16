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
    echo "Status Koneksi: BERHASIL TERHUBUNG!\n\n";
    
    // Cek jumlah data di tabel utama
    echo "Database: simpadu siap diuji.\n";


    echo "\nKombinasi STATUS & FLAG pada periode-periode 2026:\n";
    $stmt = $pdo->query("SELECT PERIODE, STATUS, FLAG, COUNT(*) cnt FROM spd_rekening WHERE PERIODE >= '202605' GROUP BY PERIODE, STATUS, FLAG ORDER BY PERIODE DESC, STATUS");
    while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
        echo "  Periode: {$r['PERIODE']} | STATUS: '{$r['STATUS']}' | FLAG: '{$r['FLAG']}' | Jumlah: " . number_format($r['cnt']) . "\n";
    }



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

