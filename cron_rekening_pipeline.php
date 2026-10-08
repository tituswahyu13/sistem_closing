<?php
// ====================================================================
// CRON RUNNER CLOSING REKENING PIPELINE 6-TAHAP
// Jadwal: Tanggal 1 Pukul 00:00 WIB
// Perintah Cron: 0 0 1 * * php /path/to/cron_rekening_pipeline.php >> /path/to/rekening_cron.log 2>&1
// ====================================================================

date_default_timezone_set('Asia/Jakarta');

require_once __DIR__ . '/pipeline_runner.php';

$nowStr = date('Y-m-d H:i:s');
echo "[$nowStr] === MEMULAI CRON CLOSING REKENING PIPELINE (6 TAHAPAN) ===\n";

try {
    $pdo = getMasterPipelineDb();
    initPipelineLogTable($pdo);

    // Cek jadwal PENDING dari rekening_config jika ada
    $stmt = $pdo->query("
        SELECT * FROM rekening_config 
        WHERE status = 'PENDING' AND jadwal_eksekusi <= NOW() 
        ORDER BY jadwal_eksekusi ASC 
        LIMIT 1
    ");
    $config = $stmt->fetch(PDO::FETCH_ASSOC);

    $userId = 1;
    $periode = null;

    if ($config) {
        $periode = $config['periode'];
        $userId = intval($config['user_id_input']) ?: 1;
        echo "[$nowStr] Menemukan konfigurasi jadwal closing rekening untuk Periode {$periode}\n";
        
        $pdo->prepare("UPDATE rekening_config SET status = 'RUNNING', waktu_eksekusi = NOW() WHERE id = :id")->execute(['id' => $config['id']]);
    }

    $result = executeClosingRekeningPipeline([
        'executed_by' => 'SYSTEM_CRON',
        'periode' => $periode,
        'user_id' => $userId
    ]);

    if ($result['success']) {
        echo "[$nowStr] CRON CLOSING REKENING BERHASIL DIEKSEKUSI PENUH DALAM {$result['durasi_total_detik']} DETIK.\n";
        if ($config) {
            $pdo->prepare("UPDATE rekening_config SET status = 'SUCCESS', pesan_terakhir = 'Closing Rekening Selesai Sukses' WHERE id = :id")->execute(['id' => $config['id']]);
        }
    } else {
        echo "[$nowStr] CRON CLOSING REKENING GAGAL: {$result['error']}\n";
        if ($config) {
            $pdo->prepare("UPDATE rekening_config SET status = 'FAILED', pesan_terakhir = :pesan WHERE id = :id")->execute([
                'id' => $config['id'],
                'pesan' => 'Closing Rekening Gagal: ' . $result['error']
            ]);
        }
    }

} catch (Exception $e) {
    echo "[$nowStr] CRON RUNNER EXCEPTION: " . $e->getMessage() . "\n";
}
