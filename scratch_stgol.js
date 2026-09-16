const mysql = require('mysql2');
const c = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'simpadu'
});

const stgolLain = "('IB', 'IIB1', 'IIB3', 'IA', 'IIB2', 'IB3', 'IB2', 'IB1', 'IIB4')";

c.query(`
    SELECT a.STGOL_ID, a.STATUS, COUNT(*) as cnt
    FROM spd_rekening a
    WHERE a.PERIODE = '202608' AND a.FLAG = '0' AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L')
      AND a.STATUS != 'l'
      AND a.STGOL_ID IN ${stgolLain}
    GROUP BY a.STGOL_ID, a.STATUS
    ORDER BY a.STGOL_ID
`, (err, res) => {
    let total = 0;
    res.forEach(r => total += r.cnt);
    console.log('Distribusi:', res);
    console.log('Total baris:', total);
    c.end();
});
