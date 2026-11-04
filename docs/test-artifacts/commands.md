| # | الأمر | البيئة | الزمن (ث) | رمز الخروج | النتيجة | المخرج |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `npm run lint:js` | sandbox · node v22.22.3 | 0.78 | 0 | PASS | `docs/test-artifacts/cmd-01.log` |
| 2 | `npm run lint:css` | sandbox · node v22.22.3 | 0.78 | 0 | PASS | `docs/test-artifacts/cmd-02.log` |
| 3 | `npm run lint:html` | sandbox · node v22.22.3 | 0.23 | 0 | PASS | `docs/test-artifacts/cmd-03.log` |
| 4 | `npm run test:unit` | sandbox · node v22.22.3 | 1.10 | 0 | PASS | `docs/test-artifacts/cmd-04.log` |
| 5 | `npm run test:e2e` | sandbox · node v22.22.3 | 14.83 | 1 | FAIL | `docs/test-artifacts/cmd-05.log` |
