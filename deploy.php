<?php
// ==============================================================================
// GITHUB WEBHOOK AUTO-DEPLOYMENT HANDLER
// ==============================================================================

date_default_timezone_set('Asia/Jakarta');
header('Content-Type: application/json; charset=UTF-8');

// Secret token untuk validasi keaslian webhook GitHub
$secret = 'SimpaduClosing2026SecureKey!';

$logFile = __DIR__ . '/deploy.log';
function writeDeployLog($msg, $logFile) {
    $now = date('Y-m-d H:i:s');
    file_put_contents($logFile, "[$now] $msg\n", FILE_APPEND);
}

// 1. Ambil payload dan signature dari header GitHub
$payload = file_get_contents('php://input');
$signatureHeader = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';

// Verifikasi Signature GitHub (HMAC SHA-256)
if (!empty($secret)) {
    if (empty($signatureHeader)) {
        http_response_code(403);
        writeDeployLog("ERROR: Request ditolak karena signature tidak ditemukan.", $logFile);
        echo json_encode(["status" => "error", "message" => "X-Hub-Signature-256 header missing."]);
        exit;
    }

    $hash = 'sha256=' . hash_hmac('sha256', $payload, $secret);
    if (!hash_equals($hash, $signatureHeader)) {
        http_response_code(403);
        writeDeployLog("ERROR: Invalid signature hash. Akses ditolak.", $logFile);
        echo json_encode(["status" => "error", "message" => "Invalid HMAC signature."]);
        exit;
    }
}

// 2. Cek event GitHub (hanya proses push ke main)
$event = $_SERVER['HTTP_X_GITHUB_EVENT'] ?? 'push';
if ($event === 'ping') {
    writeDeployLog("SUCCESS: Ping event dari GitHub diterima.", $logFile);
    echo json_encode(["status" => "success", "message" => "Webhook pong!"]);
    exit;
}

if ($event !== 'push') {
    writeDeployLog("INFO: Event '$event' diabaikan (hanya memproses event push).", $logFile);
    echo json_encode(["status" => "ignored", "message" => "Event ignored."]);
    exit;
}

$data = json_decode($payload, true);
$ref = $data['ref'] ?? '';
$commitMsg = $data['head_commit']['message'] ?? '-';
$author = $data['head_commit']['author']['name'] ?? 'Unknown';

if ($ref !== 'refs/heads/main' && $ref !== 'refs/heads/master') {
    writeDeployLog("INFO: Push pada branch '$ref' diabaikan (hanya branch main yang di-deploy).", $logFile);
    echo json_encode(["status" => "ignored", "message" => "Non-main branch push."]);
    exit;
}

writeDeployLog("========================================================", $logFile);
writeDeployLog("MEMULAI AUTO-DEPLOY (Commit: '$commitMsg' oleh $author)...", $logFile);

// 3. Eksekusi git pull di direktori aplikasi
$output = [];
$returnVar = 0;
$cmd = "cd " . escapeshellarg(__DIR__) . " && git pull origin main 2>&1";
exec($cmd, $output, $returnVar);

$resultText = implode("\n", $output);
writeDeployLog("Hasil Git Pull:\n" . $resultText, $logFile);

if ($returnVar === 0) {
    writeDeployLog("SUCCESS: Auto-deploy berhasil diterapkan!", $logFile);
    writeDeployLog("========================================================", $logFile);
    echo json_encode([
        "status" => "success",
        "message" => "Deployment berhasil diterapkan ke server!",
        "commit" => $commitMsg,
        "output" => $output
    ]);
} else {
    writeDeployLog("ERROR: Git pull gagal (Return code: $returnVar).", $logFile);
    writeDeployLog("========================================================", $logFile);
    http_response_code(500);
    echo json_encode([
        "status" => "error",
        "message" => "Deployment gagal saat git pull.",
        "output" => $output,
        "code" => $returnVar
    ]);
}
