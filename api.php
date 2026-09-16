<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");
set_time_limit(0);
ini_set('memory_limit', '512M');

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

        // 1. Data Tunggakan
        $pdo->exec("
            INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
            SELECT no_pdam, 'Tunggakan' FROM spd_tunggak c 
            WHERE c.IS_DELETE = 0 AND (
                (c.IS_YKK = 0 AND c.LUNAS = 0) 
                OR (c.IS_YKK = 1 AND c.PH = 'P')
            );
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
            $stmt = $pdo->prepare($query);
            $stmt->execute(['periode' => $periode]);
            $data = $stmt->fetchAll();
            echo json_encode($data);
        }
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(["error" => $e->getMessage()]);
    }
} else {
    echo json_encode(["message" => "Welcome to API. Use ?action=beli or ?action=batal"]);
}
