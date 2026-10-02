<?php
// ==============================================================================
// RESTORE RUNNER OTOMATIS DATABASE SIMPADU (PHP CLI / WEB)
// ==============================================================================

date_default_timezone_set('Asia/Jakarta');
set_time_limit(0);
ini_set('memory_limit', '512M');

$envFile = __DIR__ . '/.env';
$env = file_exists($envFile) ? parse_ini_file($envFile) : [];
$host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : '192.168.0.10';
$defaultDb = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : 'xyz123';
$port = !empty($env['PORT']) ? $env['PORT'] : '3306';

$backupDir = __DIR__ . '/backups';
$logFile = "{$backupDir}/restore.log";
$pidFile = "{$backupDir}/.restore.pid";

// Catat PID aktif dan bersihkan saat skrip selesai
if (!is_dir($backupDir)) mkdir($backupDir, 0755, true);
file_put_contents($pidFile, getmypid());
register_shutdown_function(function() use ($pidFile) {
    if (file_exists($pidFile)) @unlink($pidFile);
});

function writeRestoreLog($msg, $logFile) {
    $now = date('Y-m-d H:i:s');
    $line = "[$now] $msg\n";
    file_put_contents($logFile, $line, FILE_APPEND);
    if (php_sapi_name() === 'cli') {
        echo $line;
    }
}

// Cari binary mysql & gunzip
$mysqlPath = 'mysql';
$possibleMysql = ['/opt/homebrew/bin/mysql', '/usr/local/bin/mysql', '/usr/bin/mysql'];
foreach ($possibleMysql as $path) {
    if (file_exists($path) && is_executable($path)) {
        $mysqlPath = $path;
        break;
    }
}

$gunzipPath = 'gunzip';
$possibleGunzip = ['/usr/bin/gunzip', '/opt/homebrew/bin/gunzip', '/usr/local/bin/gunzip'];
foreach ($possibleGunzip as $path) {
    if (file_exists($path) && is_executable($path)) {
        $gunzipPath = $path;
        break;
    }
}

// Parameter input (CLI / include)
$targetFile = $argv[1] ?? ($GLOBALS['RESTORE_FILE'] ?? '');
$targetDb   = $argv[2] ?? ($GLOBALS['RESTORE_DB'] ?? $defaultDb);
$safetyBackup = isset($argv[3]) ? ($argv[3] === '1' || $argv[3] === 'true') : ($GLOBALS['RESTORE_SAFETY'] ?? true);

if (empty($targetFile)) {
    writeRestoreLog("ERROR: Parameter nama berkas arsip tidak boleh kosong.", $logFile);
    if (php_sapi_name() !== 'cli') {
        http_response_code(400);
        echo json_encode(["status" => "error", "message" => "Parameter berkas arsip tidak boleh kosong."]);
    }
    exit(1);
}

$cleanFileName = basename($targetFile);
$filePath = "{$backupDir}/{$cleanFileName}";

if (!file_exists($filePath) || !str_ends_with($cleanFileName, '.sql.gz')) {
    writeRestoreLog("ERROR: Berkas '{$cleanFileName}' tidak ditemukan di direktori backups atau format tidak valid.", $logFile);
    if (php_sapi_name() !== 'cli') {
        http_response_code(404);
        echo json_encode(["status" => "error", "message" => "Berkas arsip tidak ditemukan atau bukan format .sql.gz yang valid."]);
    }
    exit(1);
}

writeRestoreLog("========================================================", $logFile);
writeRestoreLog("MEMULAI PROSES PEMULIHAN (RESTORE) DATABASE...", $logFile);
writeRestoreLog("Berkas Sumber: {$cleanFileName} (" . round(filesize($filePath) / 1024 / 1024, 2) . " MB)", $logFile);
writeRestoreLog("Target Database: {$targetDb} pada {$host}:{$port}", $logFile);

// 1. Jalankan Safety Backup jika diaktifkan
if ($safetyBackup) {
    writeRestoreLog("Membuat cadangan darurat (Safety Snapshot) sebelum pemulihan...", $logFile);
    $backupScript = __DIR__ . '/backup_simpadu.php';
    if (file_exists($backupScript)) {
        exec("php " . escapeshellarg($backupScript), $sbOutput, $sbCode);
        if ($sbCode === 0) {
            writeRestoreLog("Safety snapshot berhasil dibuat.", $logFile);
        } else {
            writeRestoreLog("Peringatan: Gagal membuat safety snapshot, melanjutkan pemulihan...", $logFile);
        }
    }
}

// 2. Pastikan database target ada di MySQL
try {
    $pdo = new PDO("mysql:host={$host};port={$port};charset=utf8mb4", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `" . str_replace("`", "``", $targetDb) . "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;");
} catch (Exception $e) {
    writeRestoreLog("Peringatan inisialisasi database: " . $e->getMessage(), $logFile);
}

// 3. Jalankan dekompresi dan import ke MySQL
$passArg = $pass !== '' ? "-p" . escapeshellarg($pass) : '';
$cmd = sprintf(
    "%s -c %s | %s -h %s -P %s -u %s %s --max-allowed-packet=512M --net-buffer-length=1M %s 2>&1",
    escapeshellcmd($gunzipPath),
    escapeshellarg($filePath),
    escapeshellcmd($mysqlPath),
    escapeshellarg($host),
    escapeshellarg($port),
    escapeshellarg($user),
    $passArg,
    escapeshellarg($targetDb)
);

$t0 = microtime(true);
exec($cmd, $importOutput, $returnVar);
$duration = round(microtime(true) - $t0, 2);

if ($returnVar === 0) {
    writeRestoreLog("SUCCESS: Pemulihan database '{$targetDb}' berhasil diselesaikan dalam {$duration} detik!", $logFile);
    writeRestoreLog("========================================================", $logFile);
    
    if (php_sapi_name() !== 'cli') {
        echo json_encode([
            "status" => "success",
            "message" => "Database '{$targetDb}' berhasil dipulihkan dari arsip {$cleanFileName} ({$duration}s).",
            "file" => $cleanFileName,
            "target_db" => $targetDb,
            "duration" => $duration
        ]);
    }
} else {
    $errDetail = implode("\n", $importOutput);
    writeRestoreLog("ERROR: Pemulihan database gagal (Code: {$returnVar}). Detail: {$errDetail}", $logFile);
    writeRestoreLog("========================================================", $logFile);

    if (php_sapi_name() !== 'cli') {
        http_response_code(500);
        echo json_encode([
            "status" => "error",
            "message" => "Gagal memulihkan database.",
            "error_detail" => $errDetail,
            "code" => $returnVar
        ]);
    }
}
