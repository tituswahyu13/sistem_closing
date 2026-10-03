-- ====================================================================
-- STORED PROCEDURE: sp_eksekusi_beli_ykk
-- Deskripsi: Eksekusi transaksi pembelian rekening YKK secara atomik
-- ====================================================================

DROP PROCEDURE IF EXISTS sp_eksekusi_beli_ykk;

DELIMITER //

CREATE PROCEDURE sp_eksekusi_beli_ykk(
    IN in_periode VARCHAR(6),
    IN in_budget DECIMAL(15,2),
    IN in_user_id INT,
    IN in_dry_run TINYINT,              -- 1 = Simulasi (tanpa ubah DB), 0 = Eksekusi Riil
    IN in_executed_by VARCHAR(50)       -- 'SYSTEM_CRON' atau nama user
)
proc: BEGIN
    DECLARE v_waktu_mulai DATETIME;
    DECLARE v_waktu_selesai DATETIME;
    DECLARE v_durasi DECIMAL(8,2);
    DECLARE v_tanggal_bayar DATE;
    DECLARE v_rekening_bulan DATE;
    DECLARE v_tanggal_like VARCHAR(10);
    DECLARE v_err_msg TEXT;
    
    -- Variabel ringkasan statistik
    DECLARE v_total_rek INT DEFAULT 0;
    DECLARE v_total_air DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_total_non_air DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_total_materai DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_total_tagihan DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_total_denda DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_total_bayar DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_sisa_budget DECIMAL(15,2) DEFAULT 0.00;

    -- Handler Tanggap Error: Otomatis Rollback jika terjadi kegagalan
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err_msg = MESSAGE_TEXT;
        ROLLBACK;
        
        SET v_waktu_selesai = NOW();
        SET v_durasi = TIMESTAMPDIFF(SECOND, v_waktu_mulai, v_waktu_selesai);
        
        IF in_dry_run = 0 THEN
            -- Catat status gagal ke tabel log
            INSERT INTO ykk_log_eksekusi (
                periode, budget_plafon, status, pesan, waktu_mulai, waktu_selesai, durasi_detik, executed_by
            ) VALUES (
                in_periode, in_budget, 'FAILED', CONCAT('Error Transaksi: ', v_err_msg), v_waktu_mulai, v_waktu_selesai, v_durasi, in_executed_by
            );
            
            -- Update status config
            UPDATE ykk_config 
            SET status = 'FAILED', pesan_terakhir = CONCAT('Gagal: ', v_err_msg), waktu_eksekusi = NOW()
            WHERE periode = in_periode;
        END IF;

        SELECT 'FAILED' AS status, CONCAT('Transaksi dibatalkan (Rollback): ', v_err_msg) AS pesan;
    END;

    SET v_waktu_mulai = NOW();
    SET v_tanggal_bayar = CURDATE();
    SET v_rekening_bulan = STR_TO_DATE(CONCAT(in_periode, '20'), '%Y%m%d');
    
    -- Format tanggal Like bulan berikutnya (misal periode 202409 -> 2024-10)
    SET v_tanggal_like = DATE_FORMAT(DATE_ADD(STR_TO_DATE(CONCAT(in_periode, '01'), '%Y%m%d'), INTERVAL 1 MONTH), '%Y-%m');

    -- =========================================================================
    -- 1. TABEL TEMPORARY ELIMINASI (Kriteria Bisnis)
    -- =========================================================================
    DROP TEMPORARY TABLE IF EXISTS tmp_elim;
    CREATE TEMPORARY TABLE tmp_elim (
        no_pdam VARCHAR(10) CHARACTER SET utf8 COLLATE utf8_general_ci PRIMARY KEY,
        alasan VARCHAR(20)
    ) ENGINE=MEMORY;

    -- A. Tunggakan Reguler / Non-YKK (IS_YKK = 0): Semua Belum Lunas Dieliminasi
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Tunggakan' 
    FROM spd_tunggak c USE INDEX(LUNAS)
    WHERE c.IS_DELETE = 0 
      AND c.IS_YKK = 0 
      AND c.LUNAS = 0 
      AND (c.PH IS NULL OR c.PH != 'P');

    -- B. Tunggakan YKK (IS_YKK = 1): Maksimal 3 Bulan Lolos, > 3 Bulan Dieliminasi
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Tunggakan YKK >3 Bln' 
    FROM spd_tunggak c USE INDEX(LUNAS)
    WHERE c.IS_DELETE = 0 
      AND c.IS_YKK = 1 
      AND c.LUNAS = 0
    GROUP BY no_pdam
    HAVING COUNT(*) > 3;

    -- C. Tunggakan YKK Status Penghapusan (PH = 'P')
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Tunggakan PH' 
    FROM spd_tunggak c USE INDEX(IS_YKK)
    WHERE c.IS_DELETE = 0 
      AND c.IS_YKK = 1 
      AND c.PH = 'P';

    -- D. Data Penertiban
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Penertiban' 
    FROM spd_bon d 
    WHERE d.TANGGAL LIKE CONCAT(v_tanggal_like, '-%') 
      AND d.IS_DELETE = '0' 
      AND d.STPLYN_ID LIKE 't%' 
      AND d.LUNAS = '0';

    -- E. Data Realisasi
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Realisasi' 
    FROM spd_realmohon e 
    WHERE e.TANGGAL LIKE CONCAT(v_tanggal_like, '%') 
      AND e.STPLYN_ID LIKE 't%';

    -- F. Data Subsidi
    INSERT IGNORE INTO tmp_elim (no_pdam, alasan)
    SELECT no_pdam, 'Subsidi' 
    FROM spd_rekening f 
    WHERE f.PERIODE = in_periode 
      AND f.subsidi != 0 
      AND f.FLAG = '0';

    -- =========================================================================
    -- 2. FILTER REKENING ELIGIBLE & HITUNG DENDA
    -- =========================================================================
    DROP TEMPORARY TABLE IF EXISTS tmp_eligible;
    CREATE TEMPORARY TABLE tmp_eligible (
        id INT PRIMARY KEY,
        no_pdam VARCHAR(10),
        stlgn_id INT,
        lokbay_id VARCHAR(5),
        stgol_id VARCHAR(10),
        harga_air DECIMAL(15,2),
        non_air DECIMAL(15,2),
        materai DECIMAL(15,2),
        tagihan DECIMAL(15,2),
        denda DECIMAL(15,2),
        jumlah_total DECIMAL(15,2),
        INDEX idx_sort (harga_air, non_air)
    ) ENGINE=MEMORY;

    INSERT INTO tmp_eligible (
        id, no_pdam, stlgn_id, lokbay_id, stgol_id,
        harga_air, non_air, materai, tagihan, denda, jumlah_total
    )
    SELECT 
        a.ID,
        a.NO_PDAM,
        a.STLGN_ID,
        a.LOKBAY_ID,
        a.STGOL_ID,
        CAST(a.RK AS DECIMAL(15,2)) AS harga_air,
        CAST(a.NON_AIR AS DECIMAL(15,2)) AS non_air,
        CAST(COALESCE(a.MATERAI, 0) AS DECIMAL(15,2)) AS materai,
        CAST((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0)) AS DECIMAL(15,2)) AS tagihan,
        CAST(IF((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0)) <= 50000, 
                5000, 
                pembulatanUang((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0)) * 0.1)
             ) AS DECIMAL(15,2)) AS denda,
        CAST((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0) + 
              IF((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0)) <= 50000, 
                 5000, 
                 pembulatanUang((a.RK + a.NON_AIR + COALESCE(a.MATERAI, 0)) * 0.1)
              )
             ) AS DECIMAL(15,2)) AS jumlah_total
    FROM spd_rekening a
    JOIN spd_stlgn b ON b.ID = a.STLGN_ID
    LEFT JOIN tmp_elim x ON x.no_pdam = a.no_pdam
    WHERE a.PERIODE = in_periode
      AND a.STATUS = 'a'
      AND a.FLAG = '0'
      AND a.IS_TUTUPMETER = 1
      AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L')
      AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
      AND b.nama NOT LIKE '%rumdis%' 
      AND b.nama NOT LIKE '%rumdin%' 
      AND b.nama NOT LIKE '%rusus%'
      AND x.no_pdam IS NULL
    ORDER BY (a.RK + a.NON_AIR) ASC;

    -- =========================================================================
    -- 3. TERAPKAN PLAFON BUDGET (Cumulative Sum ASC)
    -- =========================================================================
    DROP TEMPORARY TABLE IF EXISTS tmp_final_beli;
    CREATE TEMPORARY TABLE tmp_final_beli AS
    SELECT t.*
    FROM (
        SELECT 
            e.*,
            @cum_budget := @cum_budget + e.tagihan AS running_budget
        FROM tmp_eligible e
        CROSS JOIN (SELECT @cum_budget := 0.00) vars
        ORDER BY (e.harga_air + e.non_air) ASC
    ) t
    WHERE in_budget <= 0 OR t.running_budget <= in_budget;

    -- Hitung nilai akumulasi untuk log/output
    SELECT 
        COUNT(*),
        COALESCE(SUM(harga_air), 0.00),
        COALESCE(SUM(non_air), 0.00),
        COALESCE(SUM(materai), 0.00),
        COALESCE(SUM(tagihan), 0.00),
        COALESCE(SUM(denda), 0.00),
        COALESCE(SUM(jumlah_total), 0.00)
    INTO 
        v_total_rek,
        v_total_air,
        v_total_non_air,
        v_total_materai,
        v_total_tagihan,
        v_total_denda,
        v_total_bayar
    FROM tmp_final_beli;

    IF in_budget > 0 THEN
        SET v_sisa_budget = in_budget - v_total_tagihan;
    ELSE
        SET v_sisa_budget = 0.00;
    END IF;

    -- =========================================================================
    -- 4. EKSEKUSI TRANSAKSI RIIL (Hanya jika in_dry_run = 0)
    -- =========================================================================
    IF in_dry_run = 0 THEN
        START TRANSACTION;

        -- 0. Bersihkan transaksi YKK periode ini jika dieksekusi ulang (Idempotent)
        DELETE FROM spd_tunggak 
        WHERE REKENING_BULAN = v_rekening_bulan AND IS_YKK = 1;

        DELETE FROM spd_tagrek 
        WHERE REKENING_BULAN = in_periode AND IS_YKK = 1 AND TANGGAL = v_tanggal_bayar;

        -- A. Bulk Insert ke SPD_TUNGGAK (Tunggakan YKK Baru, LUNAS=0)
        INSERT INTO spd_tunggak (
            REKENING_BULAN, NO_PDAM, STLGN_ID, LOKBAY_ID, STGOL_ID,
            AIR, NON_AIR, MATERAI, DENDA, JUMLAH, LUNAS, IS_YKK,
            USER_ID_CREATE, TIME_CREATE
        )
        SELECT 
            v_rekening_bulan, no_pdam, stlgn_id, lokbay_id, stgol_id,
            harga_air, non_air, materai, denda, jumlah_total, 0, 1,
            in_user_id, NOW()
        FROM tmp_final_beli;

        -- B. Bulk Insert ke SPD_TAGREK (Rekening Laku YKK, ONLINE=20)
        INSERT INTO spd_tagrek (
            REKENING_BULAN, TANGGAL, STLGN_ID, LOKBAY_ID, STGOL_ID,
            NO_PDAM, HARGA, NON_AIR, MATERAI, DENDA, JUMLAH,
            IS_YKK, ONLINE, IS_DELETE, USER_ID_CREATE, TIME_CREATE
        )
        SELECT 
            in_periode, v_tanggal_bayar, stlgn_id, lokbay_id, stgol_id,
            no_pdam, harga_air, non_air, materai, 0, tagihan,
            1, 20, 0, in_user_id, NOW()
        FROM tmp_final_beli;

        -- C. Bulk Update SPD_REKENING (FLAG=1, IS_YKK=1)
        UPDATE spd_rekening r
        JOIN tmp_final_beli b ON b.id = r.ID
        SET 
            r.FLAG = 1,
            r.IS_YKK = 1,
            r.TAGREK_TANGGAL = v_tanggal_bayar,
            r.USER_ID_UPDATE = in_user_id,
            r.TIME_UPDATE = NOW();

        -- D. Simpan Log Audit Trail
        SET v_waktu_selesai = NOW();
        SET v_durasi = TIMESTAMPDIFF(SECOND, v_waktu_mulai, v_waktu_selesai);

        INSERT INTO ykk_log_eksekusi (
            periode, budget_plafon, total_rekening, total_air, total_non_air,
            total_materai, total_tagihan, total_denda, total_bayar, sisa_budget,
            status, pesan, waktu_mulai, waktu_selesai, durasi_detik, executed_by
        ) VALUES (
            in_periode, in_budget, v_total_rek, v_total_air, v_total_non_air,
            v_total_materai, v_total_tagihan, v_total_denda, v_total_bayar, v_sisa_budget,
            'SUCCESS', 'Eksekusi transaksi berhasil diselesaikan.', v_waktu_mulai, v_waktu_selesai, v_durasi, in_executed_by
        );

        -- E. Update Status Config
        UPDATE ykk_config 
        SET status = 'SUCCESS', 
            pesan_terakhir = CONCAT('Sukses membeli ', v_total_rek, ' rekening (Rp ', FORMAT(v_total_tagihan, 0), ')'), 
            waktu_eksekusi = NOW()
        WHERE periode = in_periode;

        COMMIT;
    END IF;

    SET v_waktu_selesai = NOW();
    SET v_durasi = TIMESTAMPDIFF(SECOND, v_waktu_mulai, v_waktu_selesai);

    -- Tampilkan ringkasan hasil
    SELECT 
        'SUCCESS' AS status,
        IF(in_dry_run = 1, 'SIMULASI_SELESAI', 'EKSEKUSI_SELESAI') AS tipe,
        in_periode AS periode,
        in_budget AS budget_plafon,
        v_total_rek AS total_rekening,
        v_total_tagihan AS total_tagihan,
        v_total_denda AS total_denda,
        v_total_bayar AS total_bayar_ykk,
        v_sisa_budget AS sisa_budget,
        v_durasi AS durasi_detik;

END //

DELIMITER ;
