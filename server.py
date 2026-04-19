from __future__ import annotations

import cgi
import json
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from epub_parser import EpubParseError, parse_epub_bytes
from metadata_store import MetadataStore, create_metadata_store
from storage import BookStorage, create_book_storage


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
STREAM_TIMEOUT_SECONDS = 25

USERS = {
    "you": {"id": "you", "name": "你", "accent": "#c65f2d"},
    "partner": {"id": "partner", "name": "男朋友", "accent": "#2f6c62"},
}


@dataclass(frozen=True)
class AppConfig:
    storage_mode: str
    database_mode: str
    bind_host: str
    local_book_dir: Path
    sqlite_db_path: Path
    postgres_dsn: str
    postgres_schema: str
    oss_bucket: str
    oss_endpoint: str
    oss_access_key_id: str
    oss_access_key_secret: str
    oss_public_base_url: str
    public_app_url: str


def load_config() -> AppConfig:
    local_book_dir = Path(
        os.environ.get("LOCAL_BOOKS_DIR") or os.environ.get("LOCAL_BOOK_DIR", DATA_DIR / "books")
    ).resolve()
    sqlite_db_path = Path(
        os.environ.get("SQLITE_PATH") or os.environ.get("SQLITE_DB_PATH", DATA_DIR / "read_together.db")
    ).resolve()
    return AppConfig(
        storage_mode=os.environ.get("STORAGE_MODE", "local"),
        database_mode=os.environ.get("DATABASE_MODE", "sqlite"),
        bind_host=os.environ.get("BIND_HOST", "0.0.0.0"),
        local_book_dir=local_book_dir,
        sqlite_db_path=sqlite_db_path,
        postgres_dsn=os.environ.get("POSTGRES_DSN", ""),
        postgres_schema=os.environ.get("POSTGRES_SCHEMA", ""),
        oss_bucket=os.environ.get("OSS_BUCKET", ""),
        oss_endpoint=os.environ.get("OSS_ENDPOINT", ""),
        oss_access_key_id=os.environ.get("OSS_ACCESS_KEY_ID", ""),
        oss_access_key_secret=os.environ.get("OSS_ACCESS_KEY_SECRET", ""),
        oss_public_base_url=os.environ.get("OSS_PUBLIC_BASE_URL", ""),
        public_app_url=os.environ.get("PUBLIC_APP_URL", ""),
    )


CONFIG = load_config()


class EventBus:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._events: list[dict[str, Any]] = []
        self._counter = 0

    def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        with self._condition:
            self._counter += 1
            self._events.append(
                {
                    "id": self._counter,
                    "type": event_type,
                    "payload": payload,
                    "created_at": time.time(),
                }
            )
            if len(self._events) > 200:
                self._events = self._events[-200:]
            self._condition.notify_all()

    def wait_since(self, last_event_id: int, timeout: int = STREAM_TIMEOUT_SECONDS) -> list[dict[str, Any]]:
        deadline = time.time() + timeout
        with self._condition:
            while True:
                ready = [event for event in self._events if event["id"] > last_event_id]
                if ready:
                    return ready
                remaining = deadline - time.time()
                if remaining <= 0:
                    return []
                self._condition.wait(remaining)


BUS = EventBus()
BOOK_STORAGE: BookStorage = create_book_storage(
    CONFIG.storage_mode,
    CONFIG.local_book_dir,
    oss_bucket=CONFIG.oss_bucket,
    oss_endpoint=CONFIG.oss_endpoint,
    oss_access_key_id=CONFIG.oss_access_key_id,
    oss_access_key_secret=CONFIG.oss_access_key_secret,
    oss_public_base_url=CONFIG.oss_public_base_url,
)
METADATA_STORE: MetadataStore = create_metadata_store(
    CONFIG.database_mode,
    CONFIG.sqlite_db_path,
    postgres_dsn=CONFIG.postgres_dsn,
    postgres_schema=CONFIG.postgres_schema,
)


def make_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{os.urandom(3).hex()}"


def bootstrap_payload() -> dict[str, Any]:
    return {
        "users": METADATA_STORE.list_users(),
        "books": METADATA_STORE.list_books(),
        "config": {
            "storageMode": CONFIG.storage_mode,
            "databaseMode": CONFIG.database_mode,
            "publicAppUrl": CONFIG.public_app_url,
        },
    }


def normalize_thread(thread: dict[str, Any]) -> dict[str, Any]:
    return {
        "highlight": thread["highlight"],
        "annotation": thread["annotation"],
        "comments": thread["comments"],
    }


class ReadTogetherHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/bootstrap":
            self.send_json(bootstrap_payload())
            return
        if parsed.path == "/api/events":
            self.handle_events(parsed.query)
            return
        if parsed.path.startswith("/api/books/") and parsed.path.endswith("/content"):
            book_id = parsed.path.split("/")[3]
            self.send_json(METADATA_STORE.get_book_content(book_id))
            return
        if parsed.path.startswith("/api/books/") and parsed.path.endswith("/threads"):
            book_id = parsed.path.split("/")[3]
            self.send_json({"threads": [normalize_thread(thread) for thread in METADATA_STORE.get_threads(book_id)]})
            return
        if parsed.path.startswith("/api/books/") and parsed.path.endswith("/export.md"):
            parts = parsed.path.split("/")
            book_id = parts[3]
            user_id = urllib.parse.parse_qs(parsed.query).get("userId", ["you"])[0]
            content = METADATA_STORE.export_notes(book_id, user_id, USERS)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{book_id}-{user_id}-notes.md"',
            )
            self.end_headers()
            self.safe_write(content.encode("utf-8"))
            return
        if parsed.path.startswith("/api/users/"):
            user_id = parsed.path.split("/")[3]
            self.send_json(METADATA_STORE.update_user_profile(user_id, {}))
            return
        if parsed.path.startswith("/api/books/"):
            book_id = parsed.path.split("/")[3]
            self.send_json(METADATA_STORE.get_book_detail(book_id))
            return
        if parsed.path == "/" or parsed.path == "":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/books/upload":
            self.handle_upload()
            return
        if parsed.path == "/api/progress":
            payload = self.read_json()
            progress = METADATA_STORE.upsert_progress(payload)
            BUS.publish("progress.updated", {"bookId": payload["bookId"], "progress": progress})
            self.send_json({"progress": progress}, status=HTTPStatus.CREATED)
            return
        if parsed.path == "/api/highlights":
            payload = self.read_json()
            thread = METADATA_STORE.create_highlight(payload)
            BUS.publish("highlight.created", {"bookId": payload["bookId"], "thread": thread})
            self.send_json({"thread": thread}, status=HTTPStatus.CREATED)
            return
        if parsed.path == "/api/annotations":
            payload = self.read_json()
            thread = METADATA_STORE.create_annotation(payload)
            BUS.publish("annotation.created", {"bookId": payload["bookId"], "thread": thread})
            self.send_json({"thread": thread}, status=HTTPStatus.CREATED)
            return
        if parsed.path == "/api/comments":
            payload = self.read_json()
            comment = METADATA_STORE.create_comment(payload)
            BUS.publish("comment.created", {"bookId": payload["bookId"], "comment": comment})
            self.send_json({"comment": comment}, status=HTTPStatus.CREATED)
            return
        if parsed.path.startswith("/api/users/"):
            user_id = parsed.path.split("/")[3]
            profile = METADATA_STORE.update_user_profile(user_id, self.read_json())
            BUS.publish("user.updated", {"user": profile})
            self.send_json({"user": profile}, status=HTTPStatus.CREATED)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_common_headers()
        self.end_headers()

    def handle_upload(self) -> None:
        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                },
            )
            file_item = form["file"] if "file" in form else None
            uploaded_by = form.getfirst("uploadedBy", "you")
            if file_item is None or not getattr(file_item, "filename", ""):
                self.send_json({"error": "Please upload an EPUB file."}, status=HTTPStatus.BAD_REQUEST)
                return
            if not str(file_item.filename).lower().endswith(".epub"):
                self.send_json({"error": "Only EPUB files are supported right now."}, status=HTTPStatus.BAD_REQUEST)
                return

            raw_bytes = file_item.file.read()
            book_id = make_id("book")
            storage_key = f"{book_id}.epub"

            try:
                parsed_book = parse_epub_bytes(raw_bytes, fallback_name=file_item.filename)
            except EpubParseError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
                return

            BOOK_STORAGE.save_book(storage_key, raw_bytes)
            payload = {
                "id": book_id,
                "title": parsed_book["title"],
                "author": parsed_book["author"],
                "fileName": file_item.filename,
                "storageKey": storage_key,
                "uploadedBy": uploaded_by,
                "chapters": parsed_book["chapters"],
            }

            try:
                METADATA_STORE.create_book(payload)
            except Exception:
                BOOK_STORAGE.delete_book(storage_key)
                raise

            book = METADATA_STORE.get_book_detail(book_id)
            BUS.publish("book.created", {"book": book})
            self.send_json({"book": book}, status=HTTPStatus.CREATED)
        except Exception as error:
            self.send_json({"error": f"Upload failed: {error}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_events(self, query_string: str) -> None:
        last_event_id = int(urllib.parse.parse_qs(query_string).get("lastEventId", ["0"])[0])
        events = BUS.wait_since(last_event_id)
        self.send_response(HTTPStatus.OK)
        self.send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.safe_write(json.dumps({"events": events}).encode("utf-8"))

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length).decode("utf-8")
        return json.loads(payload) if payload else {}

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.safe_write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def send_common_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def safe_write(self, data: bytes) -> None:
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, OSError):
            # Long polling and navigation can close the socket before the response is written.
            pass


def ensure_runtime() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    BOOK_STORAGE.ensure_ready()
    METADATA_STORE.ensure_ready()
    METADATA_STORE.seed_users(USERS)


def main() -> None:
    ensure_runtime()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((CONFIG.bind_host, port), ReadTogetherHandler)
    print(f"Read Together running at http://{CONFIG.bind_host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
