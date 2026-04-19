from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from metadata_store import SqliteMetadataStore, create_metadata_store
from storage import LocalBookStorage, create_book_storage


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate local Read Together data to cloud backends.")
    parser.add_argument("--source-sqlite", required=True, help="Path to the local sqlite database.")
    parser.add_argument("--source-books", required=True, help="Path to the local books directory.")
    parser.add_argument("--target-postgres-dsn", required=True, help="Target Postgres DSN.")
    parser.add_argument("--target-postgres-schema", default="", help="Optional target Postgres schema.")
    parser.add_argument("--oss-bucket", required=True, help="OSS bucket name.")
    parser.add_argument("--oss-endpoint", required=True, help="OSS endpoint, e.g. oss-cn-hangzhou.aliyuncs.com.")
    parser.add_argument("--oss-key-id", required=True, help="OSS AccessKey ID.")
    parser.add_argument("--oss-key-secret", required=True, help="OSS AccessKey secret.")
    parser.add_argument("--oss-public-base-url", default="", help="Optional public OSS base URL.")
    args = parser.parse_args()

    source_store = SqliteMetadataStore(Path(args.source_sqlite))
    source_store.ensure_ready()
    target_store = create_metadata_store(
        "postgres",
        Path(args.source_sqlite),
        postgres_dsn=args.target_postgres_dsn,
        postgres_schema=args.target_postgres_schema,
    )
    target_store.ensure_ready()
    local_storage = LocalBookStorage(Path(args.source_books))
    target_storage = create_book_storage(
        "object-storage",
        Path(args.source_books),
        oss_bucket=args.oss_bucket,
        oss_endpoint=args.oss_endpoint,
        oss_access_key_id=args.oss_key_id,
        oss_access_key_secret=args.oss_key_secret,
        oss_public_base_url=args.oss_public_base_url,
    )
    target_storage.ensure_ready()

    users = {user["id"]: user for user in source_store.list_users()}
    target_store.seed_users(users)
    for user in users.values():
      target_store.update_user_profile(user["id"], user)

    books = source_store.list_books()
    for book in books:
        print(f"Migrating book {book['id']} - {book['title']}")
        book_content = source_store.get_book_content(book["id"])
        raw_bytes = local_storage.read_book(book["storageKey"])
        target_storage.save_book(book["storageKey"], raw_bytes)
        target_store.create_book(
            {
                "id": book["id"],
                "title": book["title"],
                "author": book["author"],
                "fileName": book["fileName"],
                "storageKey": book["storageKey"],
                "uploadedBy": book["uploadedBy"],
                "chapters": [
                    {
                        "title": chapter["title"],
                        "href": chapter["href"],
                        "content_html": chapter["contentHtml"],
                        "plain_text": chapter["plainText"],
                    }
                    for chapter in book_content["chapters"]
                ],
            }
        )
        migrate_progress(source_store, target_store, book_content)
        migrate_threads(source_store, target_store, book["id"])

    print("Migration completed.")


def migrate_progress(source_store: SqliteMetadataStore, target_store, book_content: dict[str, Any]) -> None:
    for progress in book_content.get("progress", []):
        target_store.upsert_progress(
            {
                "bookId": book_content["id"],
                "userId": progress["userId"],
                "chapterIndex": progress["chapterIndex"],
                "pageIndex": progress.get("pageIndex", 0),
                "pageCount": progress.get("pageCount", 1),
                "chapterProgress": progress.get("chapterProgress", 0),
                "progressPercent": progress["progressPercent"],
            }
        )


def migrate_threads(source_store: SqliteMetadataStore, target_store, book_id: str) -> None:
    source_threads = source_store.get_threads(book_id)
    annotation_id_map: dict[str, str] = {}
    for thread in reversed(source_threads):
        created = target_store.create_annotation(
            {
                "bookId": book_id,
                "userId": thread["annotation"]["userId"],
                "chapterIndex": thread["highlight"]["chapterIndex"],
                "startOffset": thread["highlight"]["startOffset"],
                "endOffset": thread["highlight"]["endOffset"],
                "quote": thread["highlight"]["quote"],
                "color": thread["highlight"]["color"],
                "body": thread["annotation"]["body"],
            }
        )
        annotation_id_map[thread["annotation"]["id"]] = created["annotation"]["id"]
        for comment in thread["comments"]:
            target_store.create_comment(
                {
                    "annotationId": created["annotation"]["id"],
                    "bookId": book_id,
                    "userId": comment["userId"],
                    "body": comment["body"],
                }
            )


if __name__ == "__main__":
    main()
