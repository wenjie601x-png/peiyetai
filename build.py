#!/usr/bin/env python
"""Assemble src/ into the deployable single-file index.html.

core.js is the only place calculations live; test.mjs runs against that same
file, so `node test.mjs` verifies exactly what ships.
"""
import io, os
HERE = os.path.dirname(os.path.abspath(__file__))
R = lambda *p: io.open(os.path.join(HERE, *p), encoding="utf-8").read()

head, core, ui = R("src", "shell-head.html"), R("src", "core.js"), R("src", "ui.js")
# src/parser.js is the single source for the NL parser; splice it into core
if "/* @@PARSER@@ */" not in core:
    raise SystemExit("ERROR: core.js lost its @@PARSER@@ marker")
core = core.replace("/* @@PARSER@@ */", R("src", "parser.js"))
if "</script" in (core + ui).lower():
    raise SystemExit("ERROR: a literal </script> in the JS would break the inline bundle")

body = head + "\n" + core + "\n" + ui + "\n</script>\n"
page = ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="description" content="电化学实验配液计算器">\n'
        '<link rel="icon" href="data:image/svg+xml,'
        '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E'
        '%3Ctext y=%2226%22 font-size=%2226%22%3E%F0%9F%A7%AA%3C/text%3E%3C/svg%3E">\n'
        '</head>\n<body>\n' + body + '\n</body>\n</html>\n')

out = os.path.join(HERE, "index.html")
io.open(out, "w", encoding="utf-8").write(page)
print("built index.html  %.1f KB" % (os.path.getsize(out) / 1024))
