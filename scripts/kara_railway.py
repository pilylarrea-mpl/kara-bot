#!/usr/bin/env python3
"""Manage Kara's Railway config (variables + redeploys) via the workspace API.

The API token is read from ~/.kara-railway-token (OUTSIDE this repo, chmod 600).
No secrets live in this file, so it is safe to commit. IDs below are for the
jubilant-tenderness project / production env / kara-bot service.

Usage:
  python3 scripts/kara_railway.py list                 # list variable names
  python3 scripts/kara_railway.py get NAME             # print one value
  python3 scripts/kara_railway.py set NAME VALUE       # upsert a variable
  python3 scripts/kara_railway.py redeploy             # redeploy the service
"""
import os, sys, json, urllib.request

API = "https://backboard.railway.com/graphql/v2"
PID = "5575657f-a699-47ad-990f-d5f4769d3b39"
EID = "b07febae-13c1-4896-a55c-88659638d17c"
SID = "a71e2bea-2396-4e62-bced-fe50696fdea0"


def token():
    path = os.path.expanduser("~/.kara-railway-token")
    with open(path) as f:
        for line in f:
            if line.startswith("RAILWAY_API_TOKEN="):
                return line.strip().split("=", 1)[1]
    raise SystemExit(f"RAILWAY_API_TOKEN not found in {path}")


def gql(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        API, data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
            "User-Agent": "kara-cli",
        },
    )
    with urllib.request.urlopen(req) as r:
        out = json.load(r)
    if out.get("errors"):
        raise SystemExit("API error: " + json.dumps(out["errors"]))
    return out


def all_vars():
    r = gql(
        "query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
        {"p": PID, "e": EID, "s": SID},
    )
    return r.get("data", {}).get("variables") or {}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "list":
        for k in sorted(all_vars().keys()):
            print(k)
    elif cmd == "get":
        print(all_vars().get(sys.argv[2], ""))
    elif cmd == "set":
        name, value = sys.argv[2], sys.argv[3]
        gql(
            "mutation($i:VariableUpsertInput!){variableUpsert(input:$i)}",
            {"i": {"projectId": PID, "environmentId": EID, "serviceId": SID, "name": name, "value": value}},
        )
        print(f"set {name} ✓ (Railway will auto-redeploy)")
    elif cmd == "redeploy":
        gql(
            "mutation($e:String!,$s:String!){serviceInstanceRedeploy(environmentId:$e,serviceId:$s)}",
            {"e": EID, "s": SID},
        )
        print("redeploy triggered ✓")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
