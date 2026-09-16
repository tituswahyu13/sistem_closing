<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");
set_time_limit(180);
ini_set('memory_limit', '512M');

// Simple .env parser
$env = parse_ini_file('.env');
$host = isset($env['DB_HOST']) ? $env['DB_HOST'] : '192.168.8.11';
$db   = isset($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = isset($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = isset($env['DB_PASS']) ? $env['DB_PASS'] : 'xyz123';
$port = isset($env['PORT']) ? $env['PORT'] : '3306';

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

if ($action === 'beli') {
    $query = "
        SELECT a.*, b.* 
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
    try {
        $stmt = $pdo->prepare($query);
        $stmt->execute([
            'periode' => $periode,
            'tanggal_like' => $tanggalLike
        ]);
        $data = $stmt->fetchAll();
        echo json_encode($data);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} elseif ($action === 'batal') {
    $query = "
        SELECT a.*, b.*,
        CASE
            WHEN a.STATUS != 'a' THEN CONCAT('Status ', UPPER(a.STATUS))
            WHEN LOWER(b.NAMA) LIKE '%rumdis%' THEN 'Rumdis'
            WHEN LOWER(b.NAMA) LIKE '%rumdin%' THEN 'Rumdin'
            WHEN LOWER(b.NAMA) LIKE '%rusus%' THEN 'Rusus'
            WHEN a.no_pdam IN (
                SELECT no_pdam FROM spd_tunggak c 
                WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
            ) THEN 'Tunggakan'
            WHEN a.no_pdam IN (
                SELECT no_pdam FROM spd_bon d 
                WHERE d.TANGGAL LIKE CONCAT(:tanggal_like, '-%') AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
            ) THEN 'Penertiban'
            WHEN a.no_pdam IN (
                SELECT no_pdam FROM spd_realmohon e 
                WHERE e.TANGGAL LIKE CONCAT(:tanggal_like, '%') AND e.STPLYN_ID LIKE 't%'
            ) THEN 'Realisasi'
            WHEN a.no_pdam IN (
                SELECT no_pdam FROM spd_rekening f 
                WHERE f.subsidi != 0 AND f.FLAG = '0'
            ) THEN 'Subsidi'
            ELSE 'Lainnya'
        END AS ALASAN
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
    try {
        $stmt = $pdo->prepare($query);
        $stmt->execute([
            'periode' => $periode,
            'tanggal_like' => $tanggalLike
        ]);
        $data = $stmt->fetchAll();
        echo json_encode($data);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} else {
    echo json_encode(["message" => "Welcome to API. Use ?action=beli or ?action=batal"]);
}
