"""Static source-contract checks for the browser-only deletion UI.

These checks protect wiring and accessible markup. They do not execute JavaScript
or replace a browser/API integration test.
"""

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FrontendDeleteContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")

    def test_history_action_uses_image_id_and_delete_api_method(self):
        self.assertIn('data-delete-image="${escapeHtml(imageId)}"', self.app)
        self.assertIn('api(`/images/${encodeURIComponent(imageId)}`', self.app)
        self.assertIn('method: "DELETE"', self.app)
        self.assertIn('event.target.closest("[data-delete-image]")', self.app)

    def test_confirmation_identifies_image_and_stored_outputs(self):
        self.assertIn('id="delete-confirm-dialog"', self.html)
        self.assertIn('aria-describedby="delete-confirm-filename delete-confirm-description"', self.html)
        self.assertIn('id="delete-confirm-filename"', self.html)
        self.assertIn("stored original, resized image, and thumbnail", self.html)
        self.assertIn('id="delete-confirm-btn"', self.html)
        self.assertIn('id="delete-cancel-btn"', self.html)

    def test_delete_errors_keep_record_and_success_refreshes_statistics(self):
        delete_function = self.app.split("async function deleteHistoryItem", 1)[1]
        delete_function = delete_function.split("/* =", 1)[0]
        self.assertIn("error.status === 404", delete_function)
        self.assertIn("error.status >= 500", delete_function)
        self.assertIn("network error", delete_function)
        self.assertIn("updateStatistics();", delete_function)
        self.assertIn("renderHistory();", delete_function)
        self.assertIn("await refreshAll();", delete_function)
        self.assertIn("deletingImageIds.has(imageId)", delete_function)
        self.assertIn("deletedImageIds.add(imageId)", delete_function)
        self.assertIn("stopPolling(imageId)", delete_function)


if __name__ == "__main__":
    unittest.main()
