"""The Windows client ships a copy of the gateway as its local engine (desktop/src-tauri/tauri.conf.json resources).
Every local module those files import must be shipped too: 1.9.1–1.9.3 left out world.py, so the local engine
crashed on startup with ModuleNotFoundError and every job silently went to the cloud. Stdlib only."""
import ast
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "desktop" / "src-tauri" / "tauri.conf.json"
SOURCES = [ROOT / "backend" / "beam", ROOT / "backend" / "local_engine"]


def local_imports(path):
    """Imports that run when the module loads. Imports inside functions are left out: the gateway imports assist
    inside the /assist route, which the local engine removes (the assistant only has a key in the cloud)."""
    names = set()

    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module.split(".")[0])
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(ast.parse(path.read_text(encoding="utf-8")))
    return {name for name in names if any((folder / f"{name}.py").is_file() for folder in SOURCES)}


class BundleTests(unittest.TestCase):
    def test_engine_bundle_has_every_local_import(self):
        resources = json.loads(CONFIG.read_text(encoding="utf-8"))["bundle"]["resources"]
        shipped = {Path(target).stem: (CONFIG.parent / source).resolve()
                   for source, target in resources.items() if target.startswith("engine/") and target.endswith(".py")}
        self.assertIn("gateway", shipped)
        missing = {}
        for name, path in shipped.items():
            lost = local_imports(path) - set(shipped)
            if lost:
                missing[name] = sorted(lost)
        self.assertEqual(missing, {}, "add these modules to bundle.resources in tauri.conf.json")


if __name__ == "__main__":
    unittest.main()
