#!/bin/bash
# ==============================================================================
# SCRIPT BACKUP OTOMATIS DATABASE SIMPADU DENGAN KOMPRESI & RETENSI
# ==============================================================================

# Lokasi direktori script saat ini
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ENV_FILE="$DIR/.env"

# Muat konfigurasi database dari file .env
if [ -f "$ENV_FILE" ]; then
    DB_HOST=$(grep -E '^DB_HOST=' "$ENV_FILE" | cut -d '=' -f2- | tr -d ' "\r\n')
    DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | cut -d '=' -f2- | tr -d ' "\r\n')
    DB_PASS=$(grep -E '^DB_PASS=' "$ENV_FILE" | cut -d '=' -f2- | tr -d ' "\r\n')
    DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | cut -d '=' -f2- | tr -d ' "\r\n')
    DB_PORT=$(grep -E '^PORT=' "$ENV_FILE" | cut -d '=' -f2- | tr -d ' "\r\n')
fi

# Nilai default jika .env tidak lengkap
DB_HOST=${DB_HOST:-"192.168.0.10"}
DB_USER=${DB_USER:-"root"}
DB_NAME=${DB_NAME:-"simpadu"}
DB_PORT=${DB_PORT:-"3306"}
RETENTION_DAYS=14  # Hapus backup yang lebih lama dari 14 hari

# Direktori penyimpanan backup
BACKUP_DIR="$DIR/backups"
mkdir -p "$BACKUP_DIR"

# Format nama file backup: simpadu_YYYYMMDD_HHMMSS.sql.gz
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"
LOG_FILE="$BACKUP_DIR/backup.log"

echo "========================================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memulai proses backup database '$DB_NAME'..." | tee -a "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Host: $DB_HOST:$DB_PORT | User: $DB_USER | Target: $BACKUP_FILE" | tee -a "$LOG_FILE"

# Jalankan mysqldump dengan kompresi gzip langsung
if [ -z "$DB_PASS" ]; then
    mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        "$DB_NAME" | gzip -9 > "$BACKUP_FILE"
else
    mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        "$DB_NAME" | gzip -9 > "$BACKUP_FILE"
fi

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ -s "$BACKUP_FILE" ]; then
    FILE_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS: Backup selesai! Ukuran file: $FILE_SIZE" | tee -a "$LOG_FILE"
    
    # Pembersihan file backup lama (Retensi)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memeriksa dan membersihkan backup lama (> $RETENTION_DAYS hari)..." >> "$LOG_FILE"
    find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +$RETENTION_DAYS -exec rm -f {} \;
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pembersihan retensi selesai." >> "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Backup gagal dengan status kode $EXIT_CODE!" | tee -a "$LOG_FILE"
    # Hapus file corrupt jika ada
    [ -f "$BACKUP_FILE" ] && [ ! -s "$BACKUP_FILE" ] && rm -f "$BACKUP_FILE"
fi

echo "========================================================" >> "$LOG_FILE"
