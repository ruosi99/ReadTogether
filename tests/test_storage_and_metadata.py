from pathlib import Path
import shutil
import unittest

from metadata_store import SqliteMetadataStore
from storage import LocalBookStorage


class StorageAndMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path("tests/.tmp/runtime")
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.book_dir = self.temp_dir / "books"
        self.db_path = self.temp_dir / "read_together.db"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir.parent, ignore_errors=True)

    def test_local_book_storage_round_trip(self) -> None:
        storage = LocalBookStorage(self.book_dir)
        storage.ensure_ready()
        storage.save_book("demo/book.epub", b"hello")

        self.assertEqual(storage.read_book("demo/book.epub"), b"hello")
        self.assertTrue((self.book_dir / "demo" / "book.epub").exists())

    def test_sqlite_metadata_store_uses_storage_key(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        store.ensure_ready()
        store.seed_users(
            {
                "you": {"id": "you", "name": "你", "accent": "#c65f2d"},
                "partner": {"id": "partner", "name": "男朋友", "accent": "#2f6c62"},
            }
        )
        store.create_book(
            {
                "id": "book_1",
                "title": "Sample Book",
                "author": "Tester",
                "fileName": "sample.epub",
                "storageKey": "books/book_1.epub",
                "uploadedBy": "you",
                "chapters": [
                    {
                        "title": "Chapter One",
                        "href": "OPS/chapter1.xhtml",
                        "content_html": "<p>Hello world</p>",
                        "plain_text": "Hello world",
                    }
                ],
            }
        )

        detail = store.get_book_detail("book_1")

        self.assertEqual(detail["storageKey"], "books/book_1.epub")
        self.assertEqual(detail["chapters"][0]["title"], "Chapter One")

    def test_progress_and_annotations_are_scoped_by_user(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        store.ensure_ready()
        store.seed_users(
            {
                "you": {"id": "you", "name": "你", "accent": "#c65f2d"},
                "partner": {"id": "partner", "name": "男朋友", "accent": "#2f6c62"},
            }
        )
        store.create_book(
            {
                "id": "book_2",
                "title": "Shared Book",
                "author": "Tester",
                "fileName": "shared.epub",
                "storageKey": "books/book_2.epub",
                "uploadedBy": "you",
                "chapters": [
                    {
                        "title": "Chapter One",
                        "href": "OPS/chapter1.xhtml",
                        "content_html": "<p>Hello world</p>",
                        "plain_text": "Hello world",
                    },
                    {
                        "title": "Chapter Two",
                        "href": "OPS/chapter2.xhtml",
                        "content_html": "<p>Another chapter</p>",
                        "plain_text": "Another chapter",
                    },
                ],
            }
        )

        store.upsert_progress(
            {
                "bookId": "book_2",
                "userId": "you",
                "chapterIndex": 1,
                "pageIndex": 3,
                "pageCount": 5,
                "chapterProgress": 0.75,
                "progressPercent": 100,
            }
        )
        store.upsert_progress(
            {
                "bookId": "book_2",
                "userId": "partner",
                "chapterIndex": 0,
                "pageIndex": 0,
                "pageCount": 4,
                "chapterProgress": 0,
                "progressPercent": 0,
            }
        )
        store.create_annotation(
            {
                "bookId": "book_2",
                "userId": "you",
                "chapterIndex": 0,
                "startOffset": 0,
                "endOffset": 5,
                "quote": "Hello",
                "color": "#c65f2d",
                "body": "我的感受",
            }
        )

        detail = store.get_book_detail("book_2")
        threads = store.get_threads("book_2")
        you_progress = next(item for item in detail["progress"] if item["userId"] == "you")

        self.assertEqual(len(detail["progress"]), 2)
        self.assertEqual(you_progress["pageIndex"], 3)
        self.assertEqual(threads[0]["annotation"]["userId"], "you")

    def test_highlight_can_exist_without_annotation_and_later_receive_note(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        store.ensure_ready()
        store.seed_users(
            {
                "you": {"id": "you", "name": "Reader", "accent": "#c65f2d"},
                "partner": {"id": "partner", "name": "Partner", "accent": "#2f6c62"},
            }
        )
        store.create_book(
            {
                "id": "book_3",
                "title": "Highlight Book",
                "author": "Tester",
                "fileName": "highlight.epub",
                "storageKey": "books/book_3.epub",
                "uploadedBy": "you",
                "chapters": [
                    {
                        "title": "Chapter One",
                        "href": "OPS/chapter1.xhtml",
                        "content_html": "<p>Hello world</p>",
                        "plain_text": "Hello world",
                    }
                ],
            }
        )

        highlight_thread = store.create_highlight(
            {
                "bookId": "book_3",
                "userId": "you",
                "chapterIndex": 0,
                "startOffset": 0,
                "endOffset": 5,
                "quote": "Hello",
                "color": "#c65f2d",
            }
        )
        attached_thread = store.create_annotation(
            {
                "bookId": "book_3",
                "userId": "partner",
                "highlightId": highlight_thread["highlight"]["id"],
                "body": "Nice line",
            }
        )

        threads = store.get_threads("book_3")
        detail = store.get_book_detail("book_3")

        self.assertEqual(detail["annotationCount"], 1)
        self.assertIsNone(highlight_thread["annotation"])
        self.assertEqual(attached_thread["highlight"]["id"], highlight_thread["highlight"]["id"])
        self.assertEqual(threads[0]["annotation"]["userId"], "partner")

    def test_legacy_books_table_with_file_path_still_accepts_new_writes(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        with store.connect() as connection:
            connection.execute(
                """
                CREATE TABLE books (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    author TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    uploaded_by TEXT NOT NULL,
                    uploaded_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE chapters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT NOT NULL,
                    chapter_index INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    href TEXT NOT NULL,
                    content_html TEXT NOT NULL,
                    plain_text TEXT NOT NULL
                )
                """
            )

        store.ensure_ready()
        store.create_book(
            {
                "id": "book_legacy",
                "title": "Legacy Book",
                "author": "Tester",
                "fileName": "legacy.epub",
                "storageKey": "books/book_legacy.epub",
                "uploadedBy": "you",
                "chapters": [
                    {
                        "title": "Chapter One",
                        "href": "OPS/chapter1.xhtml",
                        "content_html": "<p>Hello</p>",
                        "plain_text": "Hello",
                    }
                ],
            }
        )

        detail = store.get_book_detail("book_legacy")
        self.assertEqual(detail["storageKey"], "books/book_legacy.epub")

    def test_user_profile_can_be_updated(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        store.ensure_ready()
        store.seed_users({"you": {"id": "you", "name": "你", "accent": "#c65f2d"}})

        updated = store.update_user_profile("you", {"name": "小读者", "avatarUrl": "data:image/png;base64,abc"})

        self.assertEqual(updated["name"], "小读者")
        self.assertEqual(store.list_users()[0]["avatarUrl"], "data:image/png;base64,abc")


    def test_placeholder_chapter_titles_are_normalized_for_existing_books(self) -> None:
        store = SqliteMetadataStore(self.db_path)
        store.ensure_ready()
        store.seed_users({"you": {"id": "you", "name": "Reader", "accent": "#c65f2d"}})
        store.create_book(
            {
                "id": "book_placeholder",
                "title": "Fallback Book",
                "author": "Tester",
                "fileName": "fallback.epub",
                "storageKey": "books/book_placeholder.epub",
                "uploadedBy": "you",
                "chapters": [
                    {
                        "title": "未知",
                        "href": "OPS/chapter1.xhtml",
                        "content_html": "<p>Hello</p>",
                        "plain_text": "Hello",
                    }
                ],
            }
        )

        detail = store.get_book_detail("book_placeholder")
        chapter = store.get_chapter_content("book_placeholder", 0)

        self.assertEqual(detail["chapters"][0]["title"], "第 1 节")
        self.assertEqual(chapter["title"], "第 1 节")


if __name__ == "__main__":
    unittest.main()
