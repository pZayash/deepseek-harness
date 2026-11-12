# ACP acceptance report

- When: 2026-11-12T08:38:57.208Z
- Node: v24.22.2 (win32/x64)
- Server version: 0.2.2-alpha.3
- Mode: full

| ID | Case | Result | ms | Detail / error |
|---|---|---|---|---|
| T1 | initialize advertises list/resume/fork/delete/close | pass | 2903 | {"server":{"name":"deepseek-harness-acp","version":"0.2.2-alpha.3"},"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"sessionCapabilities":["close","list","resume","fork","delete"]} |
| T2 | new session completes a real model turn | pass | 1184 | {"sessionId":"890a2ca0-3c03-4fac-aab1-a9b41a42c1f8","stopReason":"end_turn","answerPrefix":"OK"} |
| T3 | fork a live session | pass | 36 | {"sessionId":"ee9be902-1a32-4d11-987d-68535ae157ee"} |
| T4 | fork inherits the completed conversation | pass | 913 | {"answer":"BANANA-42"} |
| T5 | close the source session | pass | 3 | {"sessionId":"890a2ca0-3c03-4fac-aab1-a9b41a42c1f8"} |
| T6 | session/list returns a cached title | pass | 4 | {"title":"Remember this codeword for later:"} |
| T7 | fork a closed session | pass | 21 | {"sessionId":"9f505c53-5423-44dc-9f1b-d132806aca1f"} |
| T8 | resume a closed session | pass | 15 | {"configOptionCount":3} |
| T9 | fork rejects a mismatched cwd | pass | 8 | {"error":"[-32602] Invalid params: session cwd does not match: C:\\Users\\paza\\AppData\\Local\\Temp"} |
| T14 | load replays the committed conversation | pass | 14 | {"replayedChars":1949} |
| T12 | delete a closed session | pass | 18 | {"secondDeleteError":"[-32602] Invalid params: session is not deletable: 890a2ca0-3c03-4fac-aab1-a9b41a42c1f8"} |
| T10 | fork rejects a session without a completed turn | pass | 35 | {"error":"[-32602] Invalid params: session has no completed turn to fork: 654568e0-e362-4926-a1ba-279733deb33b"} |
| T11 | failed MCP connection rolls back session/new | pass | 122 | {"error":"[-32603] Internal error (details: mcp-client(missing): initial connection or tool synchronization failed)"} |
| T13 | delete rejects an active session | pass | 23 | {"error":"[-32602] Invalid params: session is active: 1c56d1ce-dca3-499e-9d64-4e302df7a24a"} |

All executed cases passed.

<details><summary>server stderr tail</summary>

```
[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
"C:\Users\paza\AppData\Local\Temp\acp-acceptance-home-UGYeev\no-such-mcp-binary" �� ���� ����७��� ��� ���譥�
��������, �ᯮ��塞�� �ணࠬ��� ��� ������ 䠩���.

```
</details>
