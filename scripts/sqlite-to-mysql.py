#!/usr/bin/env python3
"""把 loginapp 的 SQLite 库导出成 MySQL 可执行的 INSERT 脚本。

用法：
    python3 scripts/sqlite-to-mysql.py --sqlite /var/lib/loginapp/app.db \
        --ddl scripts/schema.mysql.sql --out /tmp/loginapp-data.sql

只搬「持久状态」：users、sso_clients。
sessions / login_fails / register_fails / sso_tickets 都是短期数据（会话、限频窗口、60 秒票据），
迁移后重建更干净——副作用是**所有用户需要重新登录一次**。

列名差异由 ALIASES 处理：SQLite 里 login_fails.key、register_fails.count 在 MySQL 里是保留字，
已分别改名为 lock_key / cnt（见 schema.mysql.sql）。
"""

import argparse
import re
import sqlite3
import sys

TABLES = ["users", "sso_clients"]

ALIASES = {
    "login_fails": {"key": "lock_key"},
    "register_fails": {"count": "cnt"},
}

CREATE_RE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\) ENGINE", re.S)
COL_RE = re.compile(r"^\s{2}(\w+)\s+([A-Za-z]+)", re.M)


def parse_ddl(path):
    ddl = open(path, encoding="utf-8").read()
    schema = {}
    for table, body in CREATE_RE.findall(ddl):
        cols = {}
        for line in body.splitlines():
            m = COL_RE.match(line)
            if not m:
                continue
            name, typ = m.group(1), m.group(2).upper()
            # 跳过索引/约束行（KEY xxx (col) / UNIQUE KEY ... / CONSTRAINT ...）
            if name.upper() in ("PRIMARY", "UNIQUE", "KEY", "CONSTRAINT", "INDEX", "FULLTEXT"):
                continue
            cols[name] = typ
        schema[table] = cols
    return schema


def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex()
    if isinstance(v, str):
        return "'" + v.replace("\\", "\\\\").replace("'", "\\'").replace("\x00", "") + "'"
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", required=True)
    ap.add_argument("--ddl", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    schema = parse_ddl(args.ddl)
    con = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    con.text_factory = str

    with open(args.out, "w", encoding="utf-8") as out:
        out.write("/* 由 scripts/sqlite-to-mysql.py 生成 */\n")
        out.write("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n")
        for table in TABLES:
            if table not in schema:
                print(f"! DDL 中没有 {table}", file=sys.stderr)
                continue
            try:
                cur = con.execute(f'SELECT * FROM "{table}"')
            except sqlite3.OperationalError as e:
                print(f"! 跳过 {table}: {e}", file=sys.stderr)
                continue

            src_cols = [d[0] for d in cur.description]
            alias = ALIASES.get(table, {})
            mapping = []  # (源列, 目标列)
            for c in src_cols:
                target = alias.get(c, c)
                if target in schema[table]:
                    mapping.append((c, target))
                else:
                    print(f"  · {table}.{c} 在 MySQL 表里没有对应列，跳过", file=sys.stderr)

            target_cols = [t for _, t in mapping]
            missing = [
                c
                for c in schema[table]
                if c not in target_cols
            ]
            if missing:
                print(f"! {table} 缺少列 {missing}，按 MySQL 默认值处理", file=sys.stderr)

            rows = []
            for row in cur:
                vals = []
                for (src, _tgt), v in zip(mapping, row):
                    typ = schema[table][_tgt]
                    if typ in ("INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "BOOLEAN"):
                        v = None if v is None else int(v)
                    elif typ in ("DOUBLE", "FLOAT", "DECIMAL"):
                        v = None if v is None else float(v)
                    vals.append(esc(v))
                rows.append("(" + ",".join(vals) + ")")

            if not rows:
                print(f"  {table}: 0 行")
                continue
            colsql = ",".join(f"`{t}`" for t in target_cols)
            out.write(f"INSERT INTO `{table}` ({colsql}) VALUES\n" + ",\n".join(rows) + ";\n\n")
            print(f"  {table}: {len(rows)} 行")

        out.write("SET FOREIGN_KEY_CHECKS=1;\n")
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
