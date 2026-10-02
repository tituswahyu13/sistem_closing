<?php
// ====================================================================
// CRON RUNNER OTOMASI BELI YKK
// Jadwal: Tanggal 21 Pukul 00:05 WIB
// Perintah Cron: 5 0 21 * * php /path/to/cron_execute_ykk.php >> /path/to/ykk_cron.log 2>&1
// ====================================================================

date_default_timezone_set('Asia/Jakarta');

$envFile = __DIR__ . '/.env';
$env = file_exists($envFile) ? parse_ini_file($envFile) : [];
$host = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
$db   = !empty($env['DB_NAME']) ? $env['DB_NAME'] : 'simpadu';
$user = !empty($env['DB_USER']) ? $env['DB_USER'] : 'root';
$pass = array_key_exists('DB_PASS', $env) ? $env['DB_PASS'] : '';
$port = !empty($env['PORT']) ? $env['PORT'] : '3306';

$nowStr = date('Y-m-d H:i:s');
echo "[$nowStr] === MEMULAI RUNNER CRON BELI YKK ===\n";

try {
    $pdo = new PDO(
        "mysql:host=$host;port=$port;dbname=$db;charset=utf8mb4",
        $user,
        $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    // Cari jadwal PENDING yang sudah jatuh tempo (jadwal_eksekusi <= NOW())
    $stmt = $pdo->query("
        SELECT * FROM ykk_config 
        WHERE status = 'PENDING' AND jadwal_eksekusi <= NOW() 
        ORDER BY jadwal_eksekusi ASC 
        LIMIT 1
    ");
    $config = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$config) {
        // Cek apakah ada jadwal PENDING di masa depan
        $stmtFuture = $pdo->query("
            SELECT * FROM ykk_config 
            WHERE status = 'PENDING' AND jadwal_eksekusi > NOW() 
            ORDER BY jadwal_eksekusi ASC 
            LIMIT 1
        ");
        $futureConfig = $stmtFuture->fetch(PDO::FETCH_ASSOC);

        if ($futureConfig) {
            echo "[$nowStr] Belum saatnya eksekusi. Jadwal berikutnya: Periode {$futureConfig['periode']} pada {$futureConfig['jadwal_eksekusi']} (Status: PENDING).\n";
            echo "[$nowStr] Runner selesai (Standby).\n";
            exit(0);
        }

        echo "[$nowStr] Tidak ada jadwal PENDING yang perlu dieksekusi saat ini.\n";
        exit(0);
    } else {
        $periodeTarget = $config['periode'];
        $budgetTarget = floatval($config['budget_plafon']);
        $userId = intval($config['user_id_input']) ?: 1;

        echo "[$nowStr] Menemukan jadwal PENDING yang jatuh tempo:\n";
        echo "   - ID: {$config['id']}\n";
        echo "   - Periode: $periodeTarget\n";
        echo "   - Jadwal Eksekusi: {$config['jadwal_eksekusi']}\n";
        echo "   - Plafon Budget: Rp " . number_format($budgetTarget, 0, ',', '.') . "\n";
        
        // Tandai RUNNING
        $pdo->prepare("UPDATE ykk_config SET status = 'RUNNING', waktu_eksekusi = NOW() WHERE id = :id")->execute(['id' => $config['id']]);
    }

    // Panggil Stored Procedure Eksekusi Riil (in_dry_run = 0)
    $stmtCall = $pdo->prepare("CALL sp_eksekusi_beli_ykk(:periode, :budget, :user_id, 0, 'SYSTEM_CRON')");
    $stmtCall->execute([
        'periode' => $periodeTarget,
        'budget' => $budgetTarget,
        'user_id' => $userId
    ]);
    
    $result = $stmtCall->fetch(PDO::FETCH_ASSOC);
    echo "[$nowStr] Hasil Eksekusi:\n";
    print_r($result);
    echo "[$nowStr] === SELESAI EKSEKUSI BELI YKK ===\n\n";

} catch (Exception $e) {
    echo "[$nowStr] ERROR EKSEKUSI: " . $e->getMessage() . "\n";
    if (isset($pdo) && isset($periodeTarget)) {
        $pdo->prepare("UPDATE ykk_config SET status = 'FAILED', pesan_terakhir = :pesan WHERE periode = :periode")
            ->execute([
                'pesan' => 'Cron Error: ' . $e->getMessage(),
                'periode' => $periodeTarget
            ]);
    }
}
