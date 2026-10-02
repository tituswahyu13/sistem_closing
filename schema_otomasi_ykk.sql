-- ====================================================================
-- SKEMA OTOMASI RENCANA BELI YKK
-- ====================================================================

-- 1. Tabel Konfigurasi Jadwal & Plafon Budget
CREATE TABLE IF NOT EXISTS ykk_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    periode VARCHAR(6) NOT NULL COMMENT 'Format YYYYMM (contoh: 202409)',
    budget_plafon DECIMAL(15,2) NOT NULL DEFAULT 0.00 COMMENT '0 jika tanpa batas budget',
    jadwal_eksekusi DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Waktu jadwal eksekusi otomatis',
    status ENUM('PENDING', 'RUNNING', 'SUCCESS', 'FAILED') DEFAULT 'PENDING',
    pesan_terakhir TEXT NULL,
    user_id_input INT DEFAULT 1,
    waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP,
    waktu_eksekusi DATETIME NULL,
    UNIQUE KEY uq_periode (periode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabel Riwayat Audit Trail Eksekusi
CREATE TABLE IF NOT EXISTS ykk_log_eksekusi (
    id INT AUTO_INCREMENT PRIMARY KEY,
    config_id INT NULL,
    periode VARCHAR(6) NOT NULL,
    budget_plafon DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_rekening INT NOT NULL DEFAULT 0,
    total_air DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_non_air DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_materai DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_tagihan DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_denda DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_bayar DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    sisa_budget DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    status ENUM('SUCCESS', 'FAILED') NOT NULL,
    pesan TEXT NULL,
    waktu_mulai DATETIME NOT NULL,
    waktu_selesai DATETIME NOT NULL,
    durasi_detik DECIMAL(8,2) NOT NULL DEFAULT 0.00,
    executed_by VARCHAR(50) DEFAULT 'SYSTEM_CRON',
    INDEX idx_periode (periode),
    INDEX idx_waktu (waktu_mulai)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
