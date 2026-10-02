<?php
// ====================================================================
// CRON RUNNER MASTER PIPELINE 6-TAHAP
// Jadwal: Tanggal 21 Pukul 00:05 WIB
// Perintah Cron: 5 0 21 * * php /path/to/cron_master_pipeline.php >> /path/to/pipeline_cron.log 2>&1
// ====================================================================

date_default_timezone_set('Asia/Jakarta');

require_once __DIR__ . '/pipeline_runner.php';

$nowStr = date('Y-m-d H:i:s');
echo "[$nowStr] === MEMULAI CRON MASTER PIPELINE (6 TAHAPAN) ===\n";

try {
    $pdo = getMasterPipelineDb();
    initPipelineLogTable($pdo);

    // Cek jadwal PENDING dari ykk_config jika ada
    $stmt = $pdo->query("
        SELECT * FROM ykk_config 
        WHERE status = 'PENDING' AND jadwal_eksekusi <= NOW() 
        ORDER BY jadwal_eksekusi ASC 
        LIMIT 1
    ");
    $config = $stmt->fetch(PDO::FETCH_ASSOC);

    $budget = null;
    $userId = 1;

    if ($config) {
        $budget = floatval($config['budget_plafon']);
        $userId = intval($config['user_id_input']) ?: 1;
        echo "[$nowStr] Menemukan konfigurasi jadwal untuk Periode {$config['periode']} (Budget: Rp " . number_format($budget, 0, ',', '.') . ")\n";
        
        $pdo->prepare("UPDATE ykk_config SET status = 'RUNNING', waktu_eksekusi = NOW() WHERE id = :id")->execute(['id' => $config['id']]);
    }

    $result = executeMasterPipeline([
        'executed_by' => 'SYSTEM_CRON',
        'budget' => $budget,
        'user_id' => $userId
    ]);

    if ($result['success']) {
        echo "[$nowStr] CRON MASTER PIPELINE BERHASIL DIEKSEKUSI PENUH DALAM {$result['durasi_total_detik']} DETIK.\n";
        if ($config) {
            $pdo->prepare("UPDATE ykk_config SET status = 'SUCCESS', pesan_terakhir = 'Pipeline Selesai Sukses' WHERE id = :id")->execute(['id' => $config['id']]);
        }
    } else {
        echo "[$nowStr] CRON MASTER PIPELINE GAGAL: {$result['error']}\n";
        if ($config) {
            $pdo->prepare("UPDATE ykk_config SET status = 'FAILED', pesan_terakhir = :pesan WHERE id = :id")->execute([
                'id' => $config['id'],
                'pesan' => 'Pipeline Gagal: ' . $result['error']
            ]);
        }
    }

} catch (Exception $e) {
    echo "[$nowStr] CRON RUNNER EXCEPTION: " . $e->getMessage() . "\n";
}
