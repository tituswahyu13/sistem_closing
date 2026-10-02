<?php
$envFile = __DIR__ . '/.env';
$env = file_exists($envFile) ? parse_ini_file($envFile) : [];
$host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
$db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : '';
$port = !empty($env['PORT']) ? $env['PORT'] : '3306';

echo "=== MEMASANG SKEMA & STORED PROCEDURE OTOMASI YKK ===\n";

try {
    $pdo = new PDO(
        "mysql:host=$host;port=$port;dbname=$db;charset=utf8mb4",
        $user,
        $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    // 1. Eksekusi Skema Tabel
    echo "1. Membuat tabel ykk_config & ykk_log_eksekusi...\n";
    $schemaSql = file_get_contents(__DIR__ . '/schema_otomasi_ykk.sql');
    $pdo->exec($schemaSql);
    echo "   -> Tabel berhasil dibuat / siap.\n";

    // 2. Eksekusi Stored Procedure
    echo "2. Memasang Stored Procedure sp_eksekusi_beli_ykk...\n";
    $pdo->exec("DROP PROCEDURE IF EXISTS sp_eksekusi_beli_ykk");
    
    // Ambil isi create procedure
    $spSql = file_get_contents(__DIR__ . '/sp_eksekusi_beli_ykk.sql');
    // Bersihkan DELIMITER syntax untuk PDO
    $spSql = preg_replace('/DELIMITER\s+\/\//i', '', $spSql);
    $spSql = preg_replace('/DELIMITER\s+;/i', '', $spSql);
    $spSql = preg_replace('/\/\/\s*$/m', '', $spSql);
    
    $pdo->exec($spSql);
    echo "   -> Stored Procedure sp_eksekusi_beli_ykk berhasil dipasang!\n";

    echo "\n=== SETUP DATABASE SELESAI DENGAN SUKSES ===\n";

} catch (Exception $e) {
    echo "ERROR: " . $e->getMessage() . "\n";
}
