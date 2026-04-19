from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def make_id(prefix: str) -> str:
    import os

    return f"{prefix}_{int(time.time() * 1000)}_{os.urandom(3).hex()}"


class MetadataStore(Protocol):
    def ensure_ready(self) -> None: ...

    def seed_users(self, users: dict[str, dict[str, Any]]) -> None: ...

    def list_users(self) -> list[dict[str, Any]]: ...

    def update_user_profile(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]: ...

    def list_books(self) -> list[dict[str, Any]]: ...

    def create_book(self, payload: dict[str, Any]) -> None: ...

    def get_book_detail(self, book_id: str) -> dict[str, Any]: ...

    def get_book_content(self, book_id: str) -> dict[str, Any]: ...

    def get_chapter_content(self, book_id: str, chapter_index: int) -> dict[str, Any]: ...

    def get_threads(self, book_id: str) -> list[dict[str, Any]]: ...

    def upsert_progress(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def create_highlight(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def create_annotation(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def create_comment(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def export_notes(self, book_id: str, user_id: str, users: dict[str, dict[str, Any]]) -> str: ...


def db_to_api(record: dict[str, Any]) -> dict[str, Any]:
    transformed = {}
    for key, value in record.items():
        parts = key.split("_")
        transformed[parts[0] + "".join(part.title() for part in parts[1:])] = value
    return transformed


SQLITE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    href TEXT NOT NULL,
    content_html TEXT NOT NULL,
    plain_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    progress_percent REAL NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(book_id, user_id)
);

CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    quote TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    highlight_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar_url TEXT,
    accent TEXT NOT NULL
);
"""

POSTGRES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id BIGSERIAL PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    href TEXT NOT NULL,
    content_html TEXT NOT NULL,
    plain_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_progress (
    id BIGSERIAL PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    progress_percent DOUBLE PRECISION NOT NULL,
    updated_at TEXT NOT NULL,
    page_index INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 1,
    chapter_progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE(book_id, user_id)
);

CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    quote TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    highlight_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar_url TEXT,
    accent TEXT NOT NULL
);
"""


class SqlParamAdapter:
    param = "?"

    def placeholders(self, count: int) -> str:
        return ", ".join([self.param] * count)

    def upsert_user(self) -> str:
        return """
        INSERT INTO users (id, name, avatar_url, accent)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = COALESCE(users.name, excluded.name),
            avatar_url = COALESCE(users.avatar_url, excluded.avatar_url),
            accent = COALESCE(users.accent, excluded.accent)
        """

    def upsert_progress(self) -> str:
        return """
        INSERT INTO reading_progress (book_id, user_id, chapter_index, progress_percent, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(book_id, user_id)
        DO UPDATE SET chapter_index = excluded.chapter_index,
                      progress_percent = excluded.progress_percent,
                      updated_at = excluded.updated_at
        """


class PostgresParamAdapter:
    def placeholders(self, count: int) -> str:
        return ", ".join(["%s"] * count)

    def upsert_user(self) -> str:
        return """
        INSERT INTO users (id, name, avatar_url, accent)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT(id) DO UPDATE SET
            name = COALESCE(users.name, EXCLUDED.name),
            avatar_url = COALESCE(users.avatar_url, EXCLUDED.avatar_url),
            accent = COALESCE(users.accent, EXCLUDED.accent)
        """

    def upsert_progress(self) -> str:
        return """
        INSERT INTO reading_progress (book_id, user_id, chapter_index, progress_percent, updated_at)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT(book_id, user_id)
        DO UPDATE SET chapter_index = EXCLUDED.chapter_index,
                      progress_percent = EXCLUDED.progress_percent,
                      updated_at = EXCLUDED.updated_at
        """


@dataclass
class SqliteMetadataStore:
    db_path: Path

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def ensure_ready(self) -> None:
        with self.connect() as connection:
            connection.executescript(SQLITE_SCHEMA_SQL)
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(books)").fetchall()
            }
            if "storage_key" not in columns:
                connection.execute("ALTER TABLE books ADD COLUMN storage_key TEXT")
            if "file_path" in columns:
                connection.execute(
                    "UPDATE books SET storage_key = COALESCE(storage_key, file_path) WHERE storage_key IS NULL OR storage_key = ''"
                )
            progress_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(reading_progress)").fetchall()
            }
            if "page_index" not in progress_columns:
                connection.execute("ALTER TABLE reading_progress ADD COLUMN page_index INTEGER NOT NULL DEFAULT 0")
            if "page_count" not in progress_columns:
                connection.execute("ALTER TABLE reading_progress ADD COLUMN page_count INTEGER NOT NULL DEFAULT 1")
            if "chapter_progress" not in progress_columns:
                connection.execute(
                    "ALTER TABLE reading_progress ADD COLUMN chapter_progress REAL NOT NULL DEFAULT 0"
                )

    def _books_columns(self, connection: sqlite3.Connection) -> set[str]:
        return {row["name"] for row in connection.execute("PRAGMA table_info(books)").fetchall()}

    def seed_users(self, users: dict[str, dict[str, Any]]) -> None:
        with self.connect() as connection:
            for user in users.values():
                connection.execute(
                    SqlParamAdapter().upsert_user(),
                    (
                        user["id"],
                        user["name"],
                        user.get("avatarUrl"),
                        user["accent"],
                    ),
                )

    def list_users(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, name, avatar_url, accent FROM users ORDER BY CASE id WHEN 'you' THEN 0 ELSE 1 END, id"
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "avatarUrl": row["avatar_url"],
                    "accent": row["accent"],
                }
                for row in rows
            ]

    def update_user_profile(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self.connect() as connection:
            current = connection.execute(
                "SELECT id, name, avatar_url, accent FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
            if current is None:
                raise KeyError(user_id)
            name = payload.get("name", current["name"]).strip() or current["name"]
            avatar_url = payload.get("avatarUrl", current["avatar_url"])
            connection.execute(
                "UPDATE users SET name = ?, avatar_url = ? WHERE id = ?",
                (name, avatar_url, user_id),
            )
            return {
                "id": user_id,
                "name": name,
                "avatarUrl": avatar_url,
                "accent": current["accent"],
            }

    def list_books(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, title, author, file_name, storage_key, uploaded_by, uploaded_at
                FROM books
                ORDER BY uploaded_at DESC
                """
            ).fetchall()
            return [self.serialize_book(connection, row["id"], row) for row in rows]

    def create_book(self, payload: dict[str, Any]) -> None:
        uploaded_at = iso_now()
        with self.connect() as connection:
            book_columns = self._books_columns(connection)
            insert_columns = ["id", "title", "author", "file_name", "uploaded_by", "uploaded_at"]
            insert_values: list[Any] = [
                payload["id"],
                payload["title"],
                payload["author"],
                payload["fileName"],
                payload["uploadedBy"],
                uploaded_at,
            ]

            if "storage_key" in book_columns:
                insert_columns.insert(4, "storage_key")
                insert_values.insert(4, payload["storageKey"])

            if "file_path" in book_columns:
                file_path_value = payload.get("filePath") or payload["storageKey"]
                file_path_index = 5 if "storage_key" in book_columns else 4
                insert_columns.insert(file_path_index, "file_path")
                insert_values.insert(file_path_index, file_path_value)

            placeholders = ", ".join(["?"] * len(insert_columns))
            connection.execute(
                f"INSERT INTO books ({', '.join(insert_columns)}) VALUES ({placeholders})",
                tuple(insert_values),
            )
            for index, chapter in enumerate(payload["chapters"]):
                connection.execute(
                    """
                    INSERT INTO chapters (book_id, chapter_index, title, href, content_html, plain_text)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["id"],
                        index,
                        chapter["title"],
                        chapter["href"],
                        chapter["content_html"],
                        chapter["plain_text"],
                    ),
                )

    def serialize_book(
        self,
        connection: sqlite3.Connection,
        book_id: str,
        row: sqlite3.Row | None = None,
    ) -> dict[str, Any]:
        if row is None:
            columns = self._books_columns(connection)
            storage_expr = "COALESCE(storage_key, file_path) AS storage_key" if "file_path" in columns else "storage_key"
            row = connection.execute(
                f"""
                SELECT id, title, author, file_name, {storage_expr}, uploaded_by, uploaded_at
                FROM books
                WHERE id = ?
                """,
                (book_id,),
            ).fetchone()
        if row is None:
            raise KeyError(book_id)

        progress_rows = connection.execute(
            """
            SELECT user_id, chapter_index, page_index, page_count, chapter_progress, progress_percent, updated_at
            FROM reading_progress
            WHERE book_id = ?
            """,
            (book_id,),
        ).fetchall()
        annotation_count = connection.execute(
            "SELECT COUNT(*) AS count FROM highlights WHERE book_id = ?",
            (book_id,),
        ).fetchone()["count"]
        chapter_count = connection.execute(
            "SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?",
            (book_id,),
        ).fetchone()["count"]
        return {
            "id": row["id"],
            "title": row["title"],
            "author": row["author"],
            "fileName": row["file_name"],
            "storageKey": row["storage_key"],
            "uploadedBy": row["uploaded_by"],
            "uploadedAt": row["uploaded_at"],
            "chapterCount": chapter_count,
            "annotationCount": annotation_count,
            "progress": [
                {
                    "userId": item["user_id"],
                    "chapterIndex": item["chapter_index"],
                    "pageIndex": item["page_index"],
                    "pageCount": item["page_count"],
                    "chapterProgress": item["chapter_progress"],
                    "progressPercent": item["progress_percent"],
                    "updatedAt": item["updated_at"],
                }
                for item in progress_rows
            ],
        }

    def get_book_detail(self, book_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            book = self.serialize_book(connection, book_id)
            chapters = connection.execute(
                """
                SELECT chapter_index, title, href
                FROM chapters
                WHERE book_id = ?
                ORDER BY chapter_index
                """,
                (book_id,),
            ).fetchall()
            book["chapters"] = [
                {"index": chapter["chapter_index"], "title": chapter["title"], "href": chapter["href"]}
                for chapter in chapters
            ]
            return book

    def get_book_content(self, book_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            book = self.serialize_book(connection, book_id)
            chapters = connection.execute(
                """
                SELECT chapter_index, title, href, content_html, plain_text
                FROM chapters
                WHERE book_id = ?
                ORDER BY chapter_index
                """,
                (book_id,),
            ).fetchall()
            book["chapters"] = [
                {
                    "index": row["chapter_index"],
                    "title": row["title"],
                    "href": row["href"],
                    "contentHtml": row["content_html"],
                    "plainText": row["plain_text"],
                }
                for row in chapters
            ]
            return book

    def get_chapter_content(self, book_id: str, chapter_index: int) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT chapter_index, title, href, content_html, plain_text
                FROM chapters
                WHERE book_id = ? AND chapter_index = ?
                """,
                (book_id, chapter_index),
            ).fetchone()
            if row is None:
                raise KeyError(f"{book_id}:{chapter_index}")
            return {
                "index": row["chapter_index"],
                "title": row["title"],
                "href": row["href"],
                "contentHtml": row["content_html"],
                "plainText": row["plain_text"],
            }

    def get_threads(self, book_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            highlight_rows = connection.execute(
                "SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at DESC",
                (book_id,),
            ).fetchall()
            annotations_by_highlight = {
                row["highlight_id"]: row
                for row in connection.execute("SELECT * FROM annotations WHERE book_id = ? ORDER BY created_at DESC", (book_id,)).fetchall()
            }
            comments_by_annotation: dict[str, list[dict[str, Any]]] = {}
            for comment in connection.execute(
                "SELECT * FROM comments WHERE book_id = ? ORDER BY created_at ASC",
                (book_id,),
            ).fetchall():
                comments_by_annotation.setdefault(comment["annotation_id"], []).append(db_to_api(dict(comment)))

            threads = []
            for highlight in highlight_rows:
                annotation = annotations_by_highlight.get(highlight["id"])
                threads.append(
                    {
                        "highlight": db_to_api(dict(highlight)),
                        "annotation": db_to_api(dict(annotation)) if annotation else None,
                        "comments": comments_by_annotation.get(annotation["id"], []) if annotation else [],
                    }
                )
            return threads

    def upsert_progress(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute(
                SqlParamAdapter().upsert_progress(),
                (
                    payload["bookId"],
                    payload["userId"],
                    int(payload["chapterIndex"]),
                    float(payload["progressPercent"]),
                    iso_now(),
                ),
            )
            connection.execute(
                """
                UPDATE reading_progress
                SET page_index = ?, page_count = ?, chapter_progress = ?
                WHERE book_id = ? AND user_id = ?
                """,
                (
                    int(payload.get("pageIndex", 0)),
                    max(1, int(payload.get("pageCount", 1))),
                    float(payload.get("chapterProgress", 0)),
                    payload["bookId"],
                    payload["userId"],
                ),
            )
            row = connection.execute(
                """
                SELECT user_id, chapter_index, page_index, page_count, chapter_progress, progress_percent, updated_at
                FROM reading_progress
                WHERE book_id = ? AND user_id = ?
                """,
                (payload["bookId"], payload["userId"]),
            ).fetchone()
            return {
                "userId": row["user_id"],
                "chapterIndex": row["chapter_index"],
                "pageIndex": row["page_index"],
                "pageCount": row["page_count"],
                "chapterProgress": row["chapter_progress"],
                "progressPercent": row["progress_percent"],
                "updatedAt": row["updated_at"],
            }

    def create_highlight(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = iso_now()
        highlight = {
            "id": make_id("highlight"),
            "book_id": payload["bookId"],
            "user_id": payload["userId"],
            "chapter_index": int(payload["chapterIndex"]),
            "start_offset": int(payload["startOffset"]),
            "end_offset": int(payload["endOffset"]),
            "quote": payload["quote"],
            "color": payload["color"],
            "created_at": created_at,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO highlights (id, book_id, user_id, chapter_index, start_offset, end_offset, quote, color, created_at)
                VALUES (:id, :book_id, :user_id, :chapter_index, :start_offset, :end_offset, :quote, :color, :created_at)
                """,
                highlight,
            )
        return {"highlight": db_to_api(highlight), "annotation": None, "comments": [], "createdHighlight": True}

    def create_annotation(self, payload: dict[str, Any]) -> dict[str, Any]:
        annotation_id = make_id("annotation")
        created_at = iso_now()
        with self.connect() as connection:
            created_highlight = False
            highlight_id = payload.get("highlightId")
            if highlight_id:
                highlight_row = connection.execute(
                    "SELECT * FROM highlights WHERE id = ? AND book_id = ?",
                    (highlight_id, payload["bookId"]),
                ).fetchone()
                if highlight_row is None:
                    raise KeyError(highlight_id)
                existing_annotation = connection.execute(
                    "SELECT id FROM annotations WHERE highlight_id = ?",
                    (highlight_id,),
                ).fetchone()
                if existing_annotation is not None:
                    raise ValueError("This highlight already has a note.")
                highlight = dict(highlight_row)
            else:
                created_highlight = True
                highlight = {
                    "id": make_id("highlight"),
                    "book_id": payload["bookId"],
                    "user_id": payload["userId"],
                    "chapter_index": int(payload["chapterIndex"]),
                    "start_offset": int(payload["startOffset"]),
                    "end_offset": int(payload["endOffset"]),
                    "quote": payload["quote"],
                    "color": payload["color"],
                    "created_at": created_at,
                }
                connection.execute(
                    """
                    INSERT INTO highlights (id, book_id, user_id, chapter_index, start_offset, end_offset, quote, color, created_at)
                    VALUES (:id, :book_id, :user_id, :chapter_index, :start_offset, :end_offset, :quote, :color, :created_at)
                    """,
                    highlight,
                )
                highlight_id = highlight["id"]
            annotation = {
                "id": annotation_id,
                "highlight_id": highlight_id,
                "book_id": payload["bookId"],
                "user_id": payload["userId"],
                "body": payload["body"],
                "created_at": created_at,
            }
            connection.execute(
                """
                INSERT INTO annotations (id, highlight_id, book_id, user_id, body, created_at)
                VALUES (:id, :highlight_id, :book_id, :user_id, :body, :created_at)
                """,
                annotation,
            )
        return {
            "highlight": db_to_api(highlight),
            "annotation": db_to_api(annotation),
            "comments": [],
            "createdHighlight": created_highlight,
        }

    def create_comment(self, payload: dict[str, Any]) -> dict[str, Any]:
        comment = {
            "id": make_id("comment"),
            "annotation_id": payload["annotationId"],
            "book_id": payload["bookId"],
            "user_id": payload["userId"],
            "body": payload["body"],
            "created_at": iso_now(),
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO comments (id, annotation_id, book_id, user_id, body, created_at)
                VALUES (:id, :annotation_id, :book_id, :user_id, :body, :created_at)
                """,
                comment,
            )
        return db_to_api(comment)

    def export_notes(self, book_id: str, user_id: str, users: dict[str, dict[str, Any]]) -> str:
        book = self.get_book_detail(book_id)
        threads = [
            thread for thread in self.get_threads(book_id) if thread["annotation"] and thread["annotation"]["userId"] == user_id
        ]
        lines = [
            f"# {book['title']} - {users[user_id]['name']}的笔记",
            "",
            f"导出时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
            "",
        ]
        if not threads:
            lines.append("暂无批注。")
            return "\n".join(lines)
        chapter_names = {chapter["index"]: chapter["title"] for chapter in book["chapters"]}
        for thread in threads:
            chapter_title = chapter_names.get(thread["highlight"]["chapterIndex"], "未命名章节")
            lines.extend(
                [
                    f"## {chapter_title}",
                    "",
                    f"> {thread['highlight']['quote']}",
                    "",
                    thread["annotation"]["body"],
                    "",
                    f"记录时间：{thread['annotation']['createdAt']}",
                    "",
                ]
            )
        return "\n".join(lines)


def _load_postgres_module():
    try:
        import psycopg as module  # type: ignore

        return module, "psycopg"
    except ImportError:
        try:
            import psycopg2 as module  # type: ignore

            return module, "psycopg2"
        except ImportError as error:
            raise RuntimeError(
                "Postgres mode requires psycopg or psycopg2. Install deployment dependencies first."
            ) from error


@dataclass
class PostgresMetadataStore:
    dsn: str
    schema: Optional[str] = None

    def __post_init__(self) -> None:
        self.module, self.driver_name = _load_postgres_module()
        self.adapter = PostgresParamAdapter()

    def connect(self):
        connection = self.module.connect(self.dsn)
        try:
            connection.autocommit = False
        except Exception:
            pass
        return connection

    def ensure_ready(self) -> None:
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"CREATE SCHEMA IF NOT EXISTS {self.schema}")
                    cursor.execute(f"SET search_path TO {self.schema}")
                for statement in [sql.strip() for sql in POSTGRES_SCHEMA_SQL.split(";") if sql.strip()]:
                    cursor.execute(statement)
            connection.commit()

    def seed_users(self, users: dict[str, dict[str, Any]]) -> None:
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                for user in users.values():
                    cursor.execute(
                        self.adapter.upsert_user(),
                        (
                            user["id"],
                            user["name"],
                            user.get("avatarUrl"),
                            user["accent"],
                        ),
                    )
            connection.commit()

    def list_users(self) -> list[dict[str, Any]]:
        rows = self._fetchall(
            "SELECT id, name, avatar_url, accent FROM users ORDER BY CASE id WHEN 'you' THEN 0 ELSE 1 END, id"
        )
        return [{"id": row["id"], "name": row["name"], "avatarUrl": row["avatar_url"], "accent": row["accent"]} for row in rows]

    def update_user_profile(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                current = self._fetchone_cursor(
                    cursor,
                    "SELECT id, name, avatar_url, accent FROM users WHERE id = %s",
                    (user_id,),
                )
                if current is None:
                    raise KeyError(user_id)
                name = payload.get("name", current["name"]).strip() or current["name"]
                avatar_url = payload.get("avatarUrl", current["avatar_url"])
                cursor.execute(
                    "UPDATE users SET name = %s, avatar_url = %s WHERE id = %s",
                    (name, avatar_url, user_id),
                )
            connection.commit()
        return {"id": user_id, "name": name, "avatarUrl": avatar_url, "accent": current["accent"]}

    def list_books(self) -> list[dict[str, Any]]:
        rows = self._fetchall(
            """
            SELECT id, title, author, file_name, storage_key, uploaded_by, uploaded_at
            FROM books
            ORDER BY uploaded_at DESC
            """
        )
        with self.connect() as connection:
            return [self.serialize_book(connection, row["id"], row) for row in rows]

    def create_book(self, payload: dict[str, Any]) -> None:
        uploaded_at = iso_now()
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                cursor.execute(
                    """
                    INSERT INTO books (id, title, author, file_name, storage_key, uploaded_by, uploaded_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        payload["id"],
                        payload["title"],
                        payload["author"],
                        payload["fileName"],
                        payload["storageKey"],
                        payload["uploadedBy"],
                        uploaded_at,
                    ),
                )
                for index, chapter in enumerate(payload["chapters"]):
                    cursor.execute(
                        """
                        INSERT INTO chapters (book_id, chapter_index, title, href, content_html, plain_text)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            payload["id"],
                            index,
                            chapter["title"],
                            chapter["href"],
                            chapter["content_html"],
                            chapter["plain_text"],
                        ),
                    )
            connection.commit()

    def serialize_book(self, connection, book_id: str, row: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if row is None:
            row = self._fetchone_connection(
                connection,
                """
                SELECT id, title, author, file_name, storage_key, uploaded_by, uploaded_at
                FROM books
                WHERE id = %s
                """,
                (book_id,),
            )
        if row is None:
            raise KeyError(book_id)
        progress_rows = self._fetchall_connection(
            connection,
            """
            SELECT user_id, chapter_index, page_index, page_count, chapter_progress, progress_percent, updated_at
            FROM reading_progress
            WHERE book_id = %s
            """,
            (book_id,),
        )
        annotation_count = self._fetchone_connection(
            connection,
            "SELECT COUNT(*) AS count FROM highlights WHERE book_id = %s",
            (book_id,),
        )["count"]
        chapter_count = self._fetchone_connection(
            connection,
            "SELECT COUNT(*) AS count FROM chapters WHERE book_id = %s",
            (book_id,),
        )["count"]
        return {
            "id": row["id"],
            "title": row["title"],
            "author": row["author"],
            "fileName": row["file_name"],
            "storageKey": row["storage_key"],
            "uploadedBy": row["uploaded_by"],
            "uploadedAt": row["uploaded_at"],
            "chapterCount": chapter_count,
            "annotationCount": annotation_count,
            "progress": [
                {
                    "userId": item["user_id"],
                    "chapterIndex": item["chapter_index"],
                    "pageIndex": item["page_index"],
                    "pageCount": item["page_count"],
                    "chapterProgress": item["chapter_progress"],
                    "progressPercent": item["progress_percent"],
                    "updatedAt": item["updated_at"],
                }
                for item in progress_rows
            ],
        }

    def get_book_detail(self, book_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            book = self.serialize_book(connection, book_id)
            chapters = self._fetchall_connection(
                connection,
                "SELECT chapter_index, title, href FROM chapters WHERE book_id = %s ORDER BY chapter_index",
                (book_id,),
            )
            book["chapters"] = [{"index": row["chapter_index"], "title": row["title"], "href": row["href"]} for row in chapters]
            return book

    def get_book_content(self, book_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            book = self.serialize_book(connection, book_id)
            chapters = self._fetchall_connection(
                connection,
                """
                SELECT chapter_index, title, href, content_html, plain_text
                FROM chapters
                WHERE book_id = %s
                ORDER BY chapter_index
                """,
                (book_id,),
            )
            book["chapters"] = [
                {
                    "index": row["chapter_index"],
                    "title": row["title"],
                    "href": row["href"],
                    "contentHtml": row["content_html"],
                    "plainText": row["plain_text"],
                }
                for row in chapters
            ]
            return book

    def get_chapter_content(self, book_id: str, chapter_index: int) -> dict[str, Any]:
        with self.connect() as connection:
            row = self._fetchone_connection(
                connection,
                """
                SELECT chapter_index, title, href, content_html, plain_text
                FROM chapters
                WHERE book_id = %s AND chapter_index = %s
                """,
                (book_id, chapter_index),
            )
            if row is None:
                raise KeyError(f"{book_id}:{chapter_index}")
            return {
                "index": row["chapter_index"],
                "title": row["title"],
                "href": row["href"],
                "contentHtml": row["content_html"],
                "plainText": row["plain_text"],
            }

    def get_threads(self, book_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            highlight_rows = self._fetchall_connection(
                connection,
                "SELECT * FROM highlights WHERE book_id = %s ORDER BY created_at DESC",
                (book_id,),
            )
            annotations_by_highlight = {
                row["highlight_id"]: row
                for row in self._fetchall_connection(
                    connection,
                    "SELECT * FROM annotations WHERE book_id = %s ORDER BY created_at DESC",
                    (book_id,),
                )
            }
            comments_by_annotation: dict[str, list[dict[str, Any]]] = {}
            for comment in self._fetchall_connection(
                connection,
                "SELECT * FROM comments WHERE book_id = %s ORDER BY created_at ASC",
                (book_id,),
            ):
                comments_by_annotation.setdefault(comment["annotation_id"], []).append(db_to_api(dict(comment)))
            threads = []
            for highlight in highlight_rows:
                annotation = annotations_by_highlight.get(highlight["id"])
                threads.append(
                    {
                        "highlight": db_to_api(dict(highlight)),
                        "annotation": db_to_api(dict(annotation)) if annotation else None,
                        "comments": comments_by_annotation.get(annotation["id"], []) if annotation else [],
                    }
                )
            return threads

    def upsert_progress(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                cursor.execute(
                    self.adapter.upsert_progress(),
                    (
                        payload["bookId"],
                        payload["userId"],
                        int(payload["chapterIndex"]),
                        float(payload["progressPercent"]),
                        iso_now(),
                    ),
                )
                cursor.execute(
                    """
                    UPDATE reading_progress
                    SET page_index = %s, page_count = %s, chapter_progress = %s
                    WHERE book_id = %s AND user_id = %s
                    """,
                    (
                        int(payload.get("pageIndex", 0)),
                        max(1, int(payload.get("pageCount", 1))),
                        float(payload.get("chapterProgress", 0)),
                        payload["bookId"],
                        payload["userId"],
                    ),
                )
                row = self._fetchone_cursor(
                    cursor,
                    """
                    SELECT user_id, chapter_index, page_index, page_count, chapter_progress, progress_percent, updated_at
                    FROM reading_progress
                    WHERE book_id = %s AND user_id = %s
                    """,
                    (payload["bookId"], payload["userId"]),
                )
            connection.commit()
        return {
            "userId": row["user_id"],
            "chapterIndex": row["chapter_index"],
            "pageIndex": row["page_index"],
            "pageCount": row["page_count"],
            "chapterProgress": row["chapter_progress"],
            "progressPercent": row["progress_percent"],
            "updatedAt": row["updated_at"],
        }

    def create_highlight(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = iso_now()
        highlight = {
            "id": make_id("highlight"),
            "book_id": payload["bookId"],
            "user_id": payload["userId"],
            "chapter_index": int(payload["chapterIndex"]),
            "start_offset": int(payload["startOffset"]),
            "end_offset": int(payload["endOffset"]),
            "quote": payload["quote"],
            "color": payload["color"],
            "created_at": created_at,
        }
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                cursor.execute(
                    """
                    INSERT INTO highlights (id, book_id, user_id, chapter_index, start_offset, end_offset, quote, color, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    tuple(highlight.values()),
                )
            connection.commit()
        return {"highlight": db_to_api(highlight), "annotation": None, "comments": [], "createdHighlight": True}

    def create_annotation(self, payload: dict[str, Any]) -> dict[str, Any]:
        annotation_id = make_id("annotation")
        created_at = iso_now()
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                created_highlight = False
                highlight_id = payload.get("highlightId")
                if highlight_id:
                    highlight = self._fetchone_cursor(
                        cursor,
                        "SELECT * FROM highlights WHERE id = %s AND book_id = %s",
                        (highlight_id, payload["bookId"]),
                    )
                    if highlight is None:
                        raise KeyError(highlight_id)
                    existing_annotation = self._fetchone_cursor(
                        cursor,
                        "SELECT id FROM annotations WHERE highlight_id = %s",
                        (highlight_id,),
                    )
                    if existing_annotation is not None:
                        raise ValueError("This highlight already has a note.")
                else:
                    created_highlight = True
                    highlight = {
                        "id": make_id("highlight"),
                        "book_id": payload["bookId"],
                        "user_id": payload["userId"],
                        "chapter_index": int(payload["chapterIndex"]),
                        "start_offset": int(payload["startOffset"]),
                        "end_offset": int(payload["endOffset"]),
                        "quote": payload["quote"],
                        "color": payload["color"],
                        "created_at": created_at,
                    }
                    cursor.execute(
                        """
                        INSERT INTO highlights (id, book_id, user_id, chapter_index, start_offset, end_offset, quote, color, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        tuple(highlight.values()),
                    )
                    highlight_id = highlight["id"]
                annotation = {
                    "id": annotation_id,
                    "highlight_id": highlight_id,
                    "book_id": payload["bookId"],
                    "user_id": payload["userId"],
                    "body": payload["body"],
                    "created_at": created_at,
                }
                cursor.execute(
                    """
                    INSERT INTO annotations (id, highlight_id, book_id, user_id, body, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    tuple(annotation.values()),
                )
            connection.commit()
        return {
            "highlight": db_to_api(highlight),
            "annotation": db_to_api(annotation),
            "comments": [],
            "createdHighlight": created_highlight,
        }

    def create_comment(self, payload: dict[str, Any]) -> dict[str, Any]:
        comment = {
            "id": make_id("comment"),
            "annotation_id": payload["annotationId"],
            "book_id": payload["bookId"],
            "user_id": payload["userId"],
            "body": payload["body"],
            "created_at": iso_now(),
        }
        with self.connect() as connection:
            with connection.cursor() as cursor:
                if self.schema:
                    cursor.execute(f"SET search_path TO {self.schema}")
                cursor.execute(
                    """
                    INSERT INTO comments (id, annotation_id, book_id, user_id, body, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    tuple(comment.values()),
                )
            connection.commit()
        return db_to_api(comment)

    def export_notes(self, book_id: str, user_id: str, users: dict[str, dict[str, Any]]) -> str:
        book = self.get_book_detail(book_id)
        threads = [
            thread for thread in self.get_threads(book_id) if thread["annotation"] and thread["annotation"]["userId"] == user_id
        ]
        lines = [
            f"# {book['title']} - {users[user_id]['name']}的笔记",
            "",
            f"导出时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
            "",
        ]
        if not threads:
            lines.append("暂无批注。")
            return "\n".join(lines)
        chapter_names = {chapter["index"]: chapter["title"] for chapter in book["chapters"]}
        for thread in threads:
            chapter_title = chapter_names.get(thread["highlight"]["chapterIndex"], "未命名章节")
            lines.extend(
                [
                    f"## {chapter_title}",
                    "",
                    f"> {thread['highlight']['quote']}",
                    "",
                    thread["annotation"]["body"],
                    "",
                    f"记录时间：{thread['annotation']['createdAt']}",
                    "",
                ]
            )
        return "\n".join(lines)

    def _fetchall(self, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.connect() as connection:
            return self._fetchall_connection(connection, query, params)

    def _fetchall_connection(self, connection, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with connection.cursor() as cursor:
            if self.schema:
                cursor.execute(f"SET search_path TO {self.schema}")
            cursor.execute(query, params)
            return self._rows_from_cursor(cursor)

    def _fetchone_connection(self, connection, query: str, params: tuple[Any, ...] = ()) -> Optional[dict[str, Any]]:
        with connection.cursor() as cursor:
            if self.schema:
                cursor.execute(f"SET search_path TO {self.schema}")
            return self._fetchone_cursor(cursor, query, params)

    def _fetchone_cursor(self, cursor, query: str, params: tuple[Any, ...] = ()) -> Optional[dict[str, Any]]:
        cursor.execute(query, params)
        row = cursor.fetchone()
        if row is None:
            return None
        columns = [desc[0] for desc in cursor.description]
        return dict(zip(columns, row))

    def _rows_from_cursor(self, cursor) -> list[dict[str, Any]]:
        columns = [desc[0] for desc in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


def create_metadata_store(
    mode: str,
    sqlite_db_path: Path,
    *,
    postgres_dsn: str = "",
    postgres_schema: str = "",
) -> MetadataStore:
    if mode == "sqlite":
        return SqliteMetadataStore(sqlite_db_path)
    if mode == "postgres":
        if not postgres_dsn:
            raise ValueError("Postgres mode requires POSTGRES_DSN.")
        return PostgresMetadataStore(postgres_dsn, postgres_schema or None)
    raise ValueError(f"Unsupported database mode: {mode}")
