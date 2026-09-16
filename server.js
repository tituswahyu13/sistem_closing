require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi Koneksi Database
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Endpoint untuk Rencana Beli YKK
app.get('/api/ykk/beli', async (req, res) => {
    try {
        const query = `
            SELECT a.*, b.*
            FROM spd_rekening a
            JOIN spd_stlgn b ON b.ID = a.STLGN_ID
            WHERE a.PERIODE = '202607'
              AND a.STATUS <> 'L'
              AND a.FLAG = '0'
              AND a.LOKBAY_ID IN ('KB','KM','KS','L')
              AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
              AND LOWER(b.NAMA) NOT LIKE '%rumdis%'
              AND LOWER(b.NAMA) NOT LIKE '%rumdin%'
              AND LOWER(b.NAMA) NOT LIKE '%rusus%'
              AND NOT EXISTS (
                  SELECT 1 FROM spd_tunggak c WHERE c.NO_PDAM = a.NO_PDAM
                  AND (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0 AND (c.PH IS NULL OR c.PH != 'P'))
              )
              AND NOT EXISTS (
                  SELECT 1 FROM spd_bon d WHERE d.NO_PDAM = a.NO_PDAM AND d.TANGGAL LIKE '2026-08-%' AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM spd_realmohon e WHERE e.NO_PDAM = a.NO_PDAM AND e.TANGGAL LIKE '2026-08%' AND e.STPLYN_ID LIKE 't%'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM spd_rekening f WHERE f.NO_PDAM = a.NO_PDAM AND f.SUBSIDI <> 0 AND f.FLAG = 0
              )
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Gagal mengambil data Beli YKK' });
    }
});

// Endpoint untuk Rencana Pembatalan YKK
app.get('/api/ykk/batal', async (req, res) => {
    try {
        const query = `
            SELECT a.*, b.*,
            CASE
                WHEN LOWER(b.NAMA) LIKE '%rumdis%' THEN 'Rumdis'
                WHEN LOWER(b.NAMA) LIKE '%rumdin%' THEN 'Rumdin'
                WHEN LOWER(b.NAMA) LIKE '%rusus%' THEN 'Rusus'
                WHEN EXISTS (SELECT 1 FROM spd_tunggak c WHERE c.NO_PDAM=a.NO_PDAM AND (c.IS_DELETE=0 AND c.IS_YKK=0 AND c.LUNAS=0 AND (c.PH IS NULL OR c.PH != 'P'))) THEN 'Tunggakan'
                WHEN EXISTS (SELECT 1 FROM spd_bon d WHERE d.NO_PDAM=a.NO_PDAM AND d.TANGGAL LIKE '2026-08-%' AND d.IS_DELETE='0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS='0') THEN 'Penertiban'
                WHEN EXISTS (SELECT 1 FROM spd_realmohon e WHERE e.NO_PDAM=a.NO_PDAM AND e.TANGGAL LIKE '2026-08%' AND e.STPLYN_ID LIKE 't%') THEN 'Realisasi'
                WHEN EXISTS (SELECT 1 FROM spd_rekening f WHERE f.NO_PDAM=a.NO_PDAM AND f.SUBSIDI<>0 AND f.FLAG=0) THEN 'Subsidi'
                ELSE 'Lainnya'
            END AS ALASAN
            FROM spd_rekening a
            JOIN spd_stlgn b ON b.ID=a.STLGN_ID
            WHERE a.PERIODE='202607'
              AND a.STATUS<>'L'
              AND a.FLAG='0'
              AND a.LOKBAY_ID IN ('KB','KM','KS','L')
              AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
              AND (
                  LOWER(b.NAMA) LIKE '%rumdis%' OR LOWER(b.NAMA) LIKE '%rumdin%' OR LOWER(b.NAMA) LIKE '%rusus%'
                  OR EXISTS (SELECT 1 FROM spd_tunggak c WHERE c.NO_PDAM=a.NO_PDAM AND (c.IS_DELETE=0 AND c.IS_YKK=0 AND c.LUNAS=0 AND (c.PH IS NULL OR c.PH != 'P')))
                  OR EXISTS (SELECT 1 FROM spd_bon d WHERE d.NO_PDAM=a.NO_PDAM AND d.TANGGAL LIKE '2026-08-%' AND d.IS_DELETE='0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS='0')
                  OR EXISTS (SELECT 1 FROM spd_realmohon e WHERE e.NO_PDAM=a.NO_PDAM AND e.TANGGAL LIKE '2026-08%' AND e.STPLYN_ID LIKE 't%')
                  OR EXISTS (SELECT 1 FROM spd_rekening f WHERE f.NO_PDAM=a.NO_PDAM AND f.SUBSIDI<>0 AND f.FLAG=0)
              )
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Gagal mengambil data Pembatalan YKK' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
