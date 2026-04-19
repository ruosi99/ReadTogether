from pathlib import Path
import shutil
import unittest
import zipfile

from epub_parser import parse_epub


class ParseEpubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path("tests/.tmp")
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_parse_minimal_epub(self) -> None:
        path = self.temp_dir / "sample.epub"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                """<?xml version="1.0"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles>
                    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
                  </rootfiles>
                </container>""",
            )
            archive.writestr(
                "OPS/content.opf",
                """<?xml version="1.0"?>
                <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:title>Sample Book</dc:title>
                    <dc:creator>Tester</dc:creator>
                  </metadata>
                  <manifest>
                    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
                  </manifest>
                  <spine>
                    <itemref idref="c1"/>
                  </spine>
                </package>""",
            )
            archive.writestr(
                "OPS/chapter1.xhtml",
                """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head>
                <body><h1>Chapter One</h1><p>Hello world.</p></body></html>""",
            )

        parsed = parse_epub(path)

        self.assertEqual(parsed["title"], "Sample Book")
        self.assertEqual(parsed["author"], "Tester")
        self.assertEqual(parsed["chapters"][0]["title"], "Chapter One")
        self.assertIn("Hello world", parsed["chapters"][0]["plain_text"])

    def test_falls_back_to_ordered_section_title_when_chapter_has_no_heading(self) -> None:
        path = self.temp_dir / "untitled.epub"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                """<?xml version="1.0"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles>
                    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
                  </rootfiles>
                </container>""",
            )
            archive.writestr(
                "OPS/content.opf",
                """<?xml version="1.0"?>
                <package version="3.0" xmlns="http://www.idpf.org/2007/opf">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:title>Untitled Segments</dc:title>
                  </metadata>
                  <manifest>
                    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
                  </manifest>
                  <spine>
                    <itemref idref="c1"/>
                  </spine>
                </package>""",
            )
            archive.writestr(
                "OPS/chapter1.xhtml",
                """<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Only body text.</p></body></html>""",
            )

        parsed = parse_epub(path)

        self.assertEqual(parsed["chapters"][0]["title"], "第 1 节")
        self.assertEqual(parsed["author"], "未知作者")

    def test_inlines_epub_image_resources_into_chapter_html(self) -> None:
        path = self.temp_dir / "image.epub"
        png_bytes = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc``\xf8\xcf"
            b"\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xe1\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                """<?xml version="1.0"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles>
                    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
                  </rootfiles>
                </container>""",
            )
            archive.writestr(
                "OPS/content.opf",
                """<?xml version="1.0"?>
                <package version="3.0" xmlns="http://www.idpf.org/2007/opf">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:title>Image Book</dc:title>
                  </metadata>
                  <manifest>
                    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
                    <item id="img1" href="images/pixel.png" media-type="image/png"/>
                  </manifest>
                  <spine>
                    <itemref idref="c1"/>
                  </spine>
                </package>""",
            )
            archive.writestr(
                "OPS/chapter1.xhtml",
                """<html xmlns="http://www.w3.org/1999/xhtml"><body>
                <p>Text before image.</p><img src="images/pixel.png" alt="pixel" />
                </body></html>""",
            )
            archive.writestr("OPS/images/pixel.png", png_bytes)

        parsed = parse_epub(path)

        self.assertIn("data:image/png;base64,", parsed["chapters"][0]["content_html"])


if __name__ == "__main__":
    unittest.main()
