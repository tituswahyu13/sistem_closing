<?php
// ==============================================================================
// BACKUP HELPER FUNCTION (PHP FUNCTION & STANDALONE EXECUTION)
// ==============================================================================

date_default_timezone_set('Asia/Jakarta');

function executeBackup() {
    $envFile = __DIR__ . '/.env';
    $env = file_exists($envFile) ? parse_ini_file($envFile) : [];
    $host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : '192.168.0.10';
    $db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
    $user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
    $pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : 'xyz123';
    $port = !empty($env['PORT']) ? $env['PORT'] : '3306';

    $backupDir = __DIR__ . '/backups';
    if (!is_dir($backupDir)) {
        mkdir($backupDir, 0755, true);
    }

    $retentionDays = 14;
    $timestamp = date('Ymd_His');
    $backupFile = "{$backupDir}/{$db}_{$timestamp}.sql.gz";
    $logFile = "{$backupDir}/backup.log";

    $writeLog = function($msg) use ($logFile) {
        $now = date('Y-m-d H:i:s');
        $line = "[$now] $msg\n";
        file_put_contents($logFile, $line, FILE_APPEND);
    };

    $writeLog("========================================================");
    $writeLog("Memulai proses backup database '{$db}'...");
    $writeLog("Host: {$host}:{$port} | User: {$user} | Target: {$backupFile}");

    // Cari binary mysqldump
    $mysqldumpPath = 'mysqldump';
    $possiblePaths = ['/opt/homebrew/bin/mysqldump', '/usr/local/bin/mysqldump', '/usr/bin/mysqldump'];
    foreach ($possiblePaths as $path) {
        if (file_exists($path) && is_executable($path)) {
            $mysqldumpPath = $path;
            break;
        }
    }

    $passArg = $pass !== '' ? "-p" . escapeshellarg($pass) : '';
    $cmd = sprintf(
        "%s -h %s -P %s -u %s %s --single-transaction --quick --routines --triggers --max-allowed-packet=512M --net-buffer-length=1M --column-statistics=0 %s 2>> %s | gzip -9 > %s",
        escapeshellcmd($mysqldumpPath),
        escapeshellarg($host),
        escapeshellarg($port),
        escapeshellarg($user),
        $passArg,
        escapeshellarg($db),
        escapeshellarg($logFile),
        escapeshellarg($backupFile)
    );

    $output = [];
    $returnVar = 0;
    exec($cmd, $output, $returnVar);

    if ($returnVar === 0 && file_exists($backupFile) && filesize($backupFile) > 0) {
        $sizeBytes = filesize($backupFile);
        $sizeMb = round($sizeBytes / 1024 / 1024, 2);
        $sizeFormatted = $sizeMb . ' MB';
        $writeLog("SUCCESS: Backup database berhasil! Ukuran file: {$sizeFormatted}");

        // Rotasi / Hapus backup lama (> $retentionDays hari)
        $files = glob("{$backupDir}/{$db}_*.sql.gz");
        $now = time();
        $deletedCount = 0;
        foreach ($files as $file) {
            if (is_file($file)) {
                if ($now - filemtime($file) >= 60 * 60 * 24 * $retentionDays) {
                    unlink($file);
                    $deletedCount++;
                }
            }
        }
        if ($deletedCount > 0) {
            $writeLog("Rotasi retensi: {$deletedCount} file backup lama (> {$retentionDays} hari) berhasil dibersihkan.");
        }
        $writeLog("========================================================");

        return [
            'success' => true,
            'message' => "Backup database berhasil disimpan ($sizeFormatted)",
            'filename' => basename($backupFile),
            'size_bytes' => $sizeBytes,
            'size_mb' => $sizeMb,
            'timestamp' => $timestamp
        ];
    } else {
        $writeLog("ERROR: Gagal membuat backup database. Return code: {$returnVar}");
        if (file_exists($backupFile) && filesize($backupFile) === 0) {
            unlink($backupFile);
        }
        $writeLog("========================================================");

        return [
            'success' => false,
            'message' => "Gagal membuat backup database (Return code: $returnVar)",
            'code' => $returnVar
        ];
    }
}

// Jika dieksekusi langsung via CLI / Web
if (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'])) {
    $res = executeBackup();
    if (php_sapi_name() === 'cli') {
        echo ($res['success'] ? "SUCCESS: " : "FAILED: ") . $res['message'] . PHP_EOL;
        exit($res['success'] ? 0 : 1);
    } else {
        header('Content-Type: application/json; charset=UTF-8');
        if (!$res['success']) {
            http_response_code(500);
        }
        echo json_encode($res);
        exit;
    }
}
