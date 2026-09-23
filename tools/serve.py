#!/usr/bin/env python3
"""Static server for local development that forbids caching, so every reload
shows the current files. Usage: tools/serve.py [bind] [port]"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002 - signature fixed by the base class
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def main() -> int:
    bind = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
    root = Path(__file__).resolve().parent.parent
    handler = lambda *args, **kwargs: NoCacheHandler(*args, directory=str(root), **kwargs)  # noqa: E731
    server = ThreadingHTTPServer((bind, port), handler)
    print(f"serving {root} on http://{bind}:{port}/ (no caching)", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
