<?php
// ==============================================================================
// BACKUP HELPER FUNCTION (PHP FUNCTION & STANDALONE EXECUTION)
// ==============================================================================

date_default_timezone_set('Asia/Jakarta');

// PHP 7 Compatibility Polyfills
if (!function_exists('str_contains')) {
    function str_contains($haystack, $needle) {
        return $needle === '' || mb_strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_starts_with')) {
    function str_starts_with($haystack, $needle) {
        return (string)$needle !== '' && strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with($haystack, $needle) {
        return $needle === '' || $needle === substr($haystack, -strlen($needle));
    }
}

function executeBackup($backupType = 'TAGIHAN', $customLabel = '') {
    $envFile = __DIR__ . '/.env';
    $env = file_exists($envFile) ? parse_ini_file($envFile) : [];
    $host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : '192.168.0.10';
    $db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
    $user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
    $pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : 'xyz123';
    $port = !empty($env['PORT']) ? $env['PORT'] : '3306';

    $backupDir = __DIR__ . '/backups';
    if (!is_dir($backupDir)) {
        @mkdir($backupDir, 0777, true);
    }
    @chmod($backupDir, 0777);
    $pidFile = "{$backupDir}/.backup.pid";
    file_put_contents($pidFile, getmypid());
    register_shutdown_function(function() use ($pidFile) {
        if (file_exists($pidFile)) @unlink($pidFile);
    });

    // Deteksi periode aktif database sesuai tipe closing
    $activePeriode = date('Ym');
    $normalizedType = strtoupper($backupType);
    if (str_contains($normalizedType, 'REKENING')) {
        $normalizedType = 'CLOSING_REKENING';
    } elseif (str_contains($normalizedType, 'TAGIHAN')) {
        $normalizedType = 'CLOSING_TAGIHAN';
    } else {
        $normalizedType = 'MANUAL';
    }

    try {
        $dsn = "mysql:host=$host;port=$port;dbname=$db;charset=utf8mb4";
        $pdo = new PDO($dsn, $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        
        if ($normalizedType === 'CLOSING_REKENING') {
            // Ambil dari spd_periode (Closing Rekening tgl 1)
            $row = $pdo->query("SELECT CONCAT(TAHUN, BULAN) AS PERIODE FROM spd_periode WHERE IS_TUTUP = 0 ORDER BY ID DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
            if (!empty($row['PERIODE'])) {
                $activePeriode = $row['PERIODE'];
            }
        } else {
            // Ambil dari spd_tutuptagihan (Closing Tagihan tgl 21 / Manual)
            $row = $pdo->query("SELECT PERIODE FROM spd_tutuptagihan WHERE IS_TUTUP = 0 ORDER BY ID DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
            if (!empty($row['PERIODE'])) {
                $activePeriode = $row['PERIODE'];
            }
        }
    } catch (Exception $e) {
        // Fallback default
    }

    $retentionDays = 14;
    $timestamp = date('Ymd_His');
    
    // Sanitasi label kustom user jika ada
    $labelPart = '';
    if (!empty($customLabel)) {
        $cleanLabel = preg_replace('/[^a-zA-Z0-9_-]/', '_', trim($customLabel));
        $cleanLabel = substr(trim($cleanLabel, '_'), 0, 30);
        if (!empty($cleanLabel)) {
            $labelPart = "_{$cleanLabel}";
        }
    }

    $backupFile = "{$backupDir}/{$db}_{$normalizedType}{$labelPart}_p{$activePeriode}_{$timestamp}.sql.gz";
    $logFile = "{$backupDir}/backup.log";

    $writeLog = function($msg) use ($logFile) {
        $now = date('Y-m-d H:i:s');
        $line = "[$now] $msg\n";
        file_put_contents($logFile, $line, FILE_APPEND);
    };

    $writeLog("========================================================");
    $writeLog("Memulai proses backup database '{$db}' (Tipe: {$normalizedType}, Periode: {$activePeriode})...");
    $writeLog("Host: {$host}:{$port} | User: {$user} | Target: {$backupFile}");

    // Cari binary mysqldump & gzip
    $mysqldumpPath = 'mysqldump';
    $possiblePaths = ['/usr/bin/mysqldump', '/usr/local/bin/mysqldump', '/opt/homebrew/bin/mysqldump'];
    foreach ($possiblePaths as $path) {
        if (file_exists($path) && is_executable($path)) {
            $mysqldumpPath = $path;
            break;
        }
    }

    $gzipPath = 'gzip';
    $possibleGzip = ['/bin/gzip', '/usr/bin/gzip', '/usr/local/bin/gzip', '/opt/homebrew/bin/gzip'];
    foreach ($possibleGzip as $path) {
        if (file_exists($path) && is_executable($path)) {
            $gzipPath = $path;
            break;
        }
    }

    // Deteksi apakah mysqldump mendukung --column-statistics (MySQL 8+ client vs MariaDB)
    $colStatOpt = '';
    $helpOut = [];
    exec(escapeshellcmd($mysqldumpPath) . " --help 2>&1", $helpOut);
    if (stripos(implode("\n", $helpOut), 'column-statistics') !== false) {
        $colStatOpt = '--column-statistics=0';
    }

    $passArg = $pass !== '' ? "-p" . escapeshellarg($pass) : '';
    $cmd = sprintf(
        "%s -h %s -P %s -u %s %s --single-transaction --quick --routines --triggers --max-allowed-packet=512M --net-buffer-length=1M %s %s 2>> %s | %s -9 > %s",
        escapeshellcmd($mysqldumpPath),
        escapeshellarg($host),
        escapeshellarg($port),
        escapeshellarg($user),
        $passArg,
        $colStatOpt,
        escapeshellarg($db),
        escapeshellarg($logFile),
        escapeshellcmd($gzipPath),
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
if (php_sapi_name() === 'cli' || (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME']))) {
    $typeArg = $argv[1] ?? ($_GET['type'] ?? 'MANUAL');
    $labelArg = $argv[2] ?? ($_GET['label'] ?? '');
    $res = executeBackup($typeArg, $labelArg);
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
