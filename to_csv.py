import sqlite3
import csv
import os

DB_PATH = "exam.db"  # або "exam_live.db" — зміни якщо треба
OUTPUT_DIR = "csv_export"

os.makedirs(OUTPUT_DIR, exist_ok=True)

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Отримати всі таблиці
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = [row[0] for row in cursor.fetchall()]

print(f"Знайдено таблиць: {tables}")

for table in tables:
    cursor.execute(f"SELECT * FROM {table}")
    rows = cursor.fetchall()
    headers = [desc[0] for desc in cursor.description]
    
    filepath = os.path.join(OUTPUT_DIR, f"{table}.csv")
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)
    
    print(f"✅ {table}.csv — {len(rows)} рядків")

conn.close()
print(f"\n📁 Всі CSV збережені в папку: {OUTPUT_DIR}/")
