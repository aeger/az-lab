#!/usr/bin/env python3
"""
Nightly batch PDF→EPUB converter for calibre library.
Converts up to MAX_BOOKS PDF-only books per run.
Priority: SF/F tagged books first, then others.
Tracks progress via PROGRESS_FILE to avoid reprocessing.
"""
import sqlite3, subprocess, os, json, time, logging, sys
from pathlib import Path
from datetime import datetime

MAX_BOOKS = 500
TIME_LIMIT_SEC = 3 * 3600  # 3 hour safety cutoff
CONTAINER = "calibre-web-automated"
DB_PATH = "/home/almty1/calibre-metadata/metadata.db"
LIBRARY_HOST = "/mnt/calibre/library"
LIBRARY_CONTAINER = "/calibre-library"
PROGRESS_FILE = "/home/almty1/azlab/services/calibre-web/pdf_epub_progress.json"
LOG_FILE = "/home/almty1/azlab/services/calibre-web/pdf_epub_convert.log"
TMP_DIR_HOST = "/mnt/calibre/library/.epub_convert_tmp"
TMP_DIR_CONTAINER = "/calibre-library/.epub_convert_tmp"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"converted": [], "failed": [], "skipped": []}


def save_progress(progress):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


def get_books_to_convert(progress):
    """Get PDF-only books ordered by priority (SF/F first)."""
    done_ids = set(progress["converted"] + progress["failed"] + progress["skipped"])

    # Open read-only to avoid creating WAL/SHM files that block container writes
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    # Priority 1: SF/F tagged books
    rows = db.execute("""
        SELECT DISTINCT b.id, b.title, b.path, d.name
        FROM books b
        JOIN data d ON b.id = d.book AND d.format = 'PDF'
        LEFT JOIN books_tags_link btl ON b.id = btl.book
        LEFT JOIN tags t ON btl.tag = t.id
        WHERE NOT EXISTS (
            SELECT 1 FROM data d2 WHERE d2.book = b.id
            AND d2.format IN ('EPUB','MOBI','AZW3','AZW','LIT')
        )
        ORDER BY
            CASE WHEN t.name IN ('Science Fiction','Fantasy','Space Opera',
                'Epic Fantasy','Urban Fantasy','Military Science Fiction') THEN 0
            ELSE 1 END,
            b.id
        LIMIT 5000
    """).fetchall()
    db.close()

    return [(r[0], r[1], r[2], r[3]) for r in rows if r[0] not in done_ids]


def convert_book_to_file(book_id, title, book_path, pdf_name):
    """Phase 1: Convert PDF→EPUB file only (no DB write). Returns epub_tmp_host path or None."""
    pdf_host = f"{LIBRARY_HOST}/{book_path}/{pdf_name}.pdf"
    pdf_container = f"{LIBRARY_CONTAINER}/{book_path}/{pdf_name}.pdf"
    epub_tmp_container = f"{TMP_DIR_CONTAINER}/{book_id}.epub"
    epub_tmp_host = f"{TMP_DIR_HOST}/{book_id}.epub"

    if not os.path.exists(pdf_host):
        log.warning(f"[{book_id}] PDF not found: {pdf_host}")
        return None

    result = subprocess.run(
        ["podman", "exec", CONTAINER,
         "ebook-convert", pdf_container, epub_tmp_container,
         "--output-profile=tablet",
         "--no-default-epub-cover",
         "--margin-top=5", "--margin-bottom=5",
         "--margin-left=5", "--margin-right=5"],
        capture_output=True, text=True, timeout=120
    )

    if result.returncode != 0 or not os.path.exists(epub_tmp_host):
        log.error(f"[{book_id}] Convert failed: {result.stderr[-200:]}")
        return None

    epub_size = os.path.getsize(epub_tmp_host)
    if epub_size < 5000:
        log.warning(f"[{book_id}] EPUB too small ({epub_size}B), skipping")
        os.remove(epub_tmp_host)
        return None

    return epub_tmp_host


def add_format_exclusive(book_id, epub_tmp_container):
    """Phase 2: Add EPUB to calibre DB using a fresh container (requires service stopped)."""
    image = subprocess.run(
        ["podman", "inspect", CONTAINER, "--format", "{{.ImageName}}"],
        capture_output=True, text=True
    ).stdout.strip()

    result = subprocess.run(
        ["podman", "run", "--rm",
         "-v", f"{LIBRARY_HOST}:{LIBRARY_CONTAINER}",
         "-v", f"{DB_PATH}:{LIBRARY_CONTAINER}/metadata.db",
         image,
         "calibredb", "add_format", str(book_id), epub_tmp_container,
         "--library-path", LIBRARY_CONTAINER],
        capture_output=True, text=True, timeout=60
    )

    if result.returncode != 0:
        log.error(f"[{book_id}] add_format failed: {result.stderr[-200:]}")
        return False
    return True


def purge_scan_books():
    """Remove the 14 identified scan-only PDF books."""
    scan_ids_file = "/tmp/scan_pdf_ids.txt"
    if not os.path.exists(scan_ids_file):
        log.info("No scan_pdf_ids.txt found, skipping purge")
        return

    with open(scan_ids_file) as f:
        lines = f.readlines()

    log.info(f"Purging {len(lines)} scan-only PDF books")
    purged = 0
    for line in lines:
        parts = line.strip().split("\t")
        if not parts:
            continue
        book_id = parts[0]
        title = parts[1] if len(parts) > 1 else "?"

        result = subprocess.run(
            ["podman", "exec", CONTAINER,
             "calibredb", "remove_format", book_id, "PDF",
             "--library-path", LIBRARY_CONTAINER],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            log.info(f"Removed PDF format from [{book_id}] {title}")
            purged += 1
        else:
            log.warning(f"Failed to remove [{book_id}] {title}: {result.stderr[:100]}")

    log.info(f"Purged {purged}/{len(lines)} scan PDFs")


def stop_calibre():
    """Stop calibre-web-automated to release database lock."""
    log.info("Stopping calibre-web-automated for exclusive DB access...")
    subprocess.run(["podman", "stop", CONTAINER], capture_output=True, timeout=30)


def start_calibre():
    """Restart calibre-web-automated after conversions."""
    log.info("Restarting calibre-web-automated...")
    subprocess.run(["systemctl", "--user", "restart", "compose-stack@calibre-web.service"],
                   capture_output=True, timeout=30)
    time.sleep(5)


def main():
    start_time = time.time()
    log.info(f"=== PDF→EPUB batch conversion started ===")

    # Ensure tmp dir exists
    os.makedirs(TMP_DIR_HOST, exist_ok=True)

    # Purge scan books on first run
    progress = load_progress()
    if not progress.get("scan_purge_done"):
        purge_scan_books()
        progress["scan_purge_done"] = True
        save_progress(progress)

    # Get books to convert
    books = get_books_to_convert(progress)
    log.info(f"Found {len(books)} PDF-only books remaining to convert")

    if not books:
        log.info("Nothing to convert, exiting.")
        return

    converted = 0
    failed = 0

    # Ensure tmp dirs exist
    subprocess.run(["podman", "exec", CONTAINER, "mkdir", "-p", TMP_DIR_CONTAINER],
                   capture_output=True)

    # Phase 1: ebook-convert (container running, no DB writes)
    epub_queue = []  # [(book_id, title, epub_tmp_container)]
    log.info("=== Phase 1: PDF→EPUB file conversion ===")
    for book_id, title, book_path, pdf_name in books:
        if len(epub_queue) >= MAX_BOOKS:
            log.info(f"Reached MAX_BOOKS limit ({MAX_BOOKS})")
            break
        if time.time() - start_time > TIME_LIMIT_SEC:
            log.info("Reached time limit in phase 1, stopping")
            break

        log.info(f"[{book_id}] Converting: {title[:60]}")
        try:
            epub_host = convert_book_to_file(book_id, title, book_path, pdf_name)
        except subprocess.TimeoutExpired:
            log.error(f"[{book_id}] Timed out")
            epub_host = None
        except Exception as e:
            log.error(f"[{book_id}] Error: {e}")
            epub_host = None

        if epub_host:
            epub_queue.append((book_id, title, f"{TMP_DIR_CONTAINER}/{book_id}.epub"))
        else:
            progress["failed"].append(book_id)
            failed += 1
            save_progress(progress)
        time.sleep(0.2)

    # Phase 2: calibredb add_format with exclusive DB access
    if epub_queue:
        log.info(f"=== Phase 2: Adding {len(epub_queue)} EPUBs to library (exclusive DB access) ===")
        stop_calibre()
        try:
            for book_id, title, epub_tmp_container in epub_queue:
                try:
                    success = add_format_exclusive(book_id, epub_tmp_container)
                except subprocess.TimeoutExpired:
                    log.error(f"[{book_id}] add_format timed out")
                    success = False
                except Exception as e:
                    log.error(f"[{book_id}] add_format error: {e}")
                    success = False

                # Clean up tmp file
                epub_host = f"{TMP_DIR_HOST}/{book_id}.epub"
                try:
                    if os.path.exists(epub_host):
                        os.remove(epub_host)
                except Exception:
                    pass

                if success:
                    progress["converted"].append(book_id)
                    converted += 1
                    log.info(f"[{book_id}] ✓ Added ({converted})")
                else:
                    progress["failed"].append(book_id)
                    failed += 1
                save_progress(progress)
        finally:
            start_calibre()

    elapsed = time.time() - start_time
    total_converted = len(progress["converted"])
    log.info(f"=== Run complete: {converted} converted, {failed} failed in {elapsed/60:.1f}m ===")
    log.info(f"=== Total converted to date: {total_converted} ===")

    # Discord notification
    msg = f"📚 Calibre nightly conversion: {converted} PDFs→EPUB ({failed} failed). Total done: {total_converted}/9543."
    subprocess.run(
        ["curl", "-s", "http://localhost:8765/send-discord",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"channel": "1012721652049657896", "message": msg})],
        capture_output=True, timeout=10
    )


if __name__ == "__main__":
    main()
