# 月／週整合與側欄拖曳示意圖

製作方式：內建 imagegen。這是概念插畫，非實際 App 截圖。

參考圖片：`docs/images/orbit-overview.png` 提供配色與品牌，`demo-month.jpg`、`demo-week.jpg` 提供主工作區的實際配置。原形象圖保留；新圖另存為 `docs/images/workspace-integration.png`。

## 生成提示詞

```text
Use case: infographic-diagram / ui-mockup.
Create a NEW visual feature illustration for the Traditional Chinese productivity app TMU IIH Orbit. This new illustration will replace a text-heavy workflow graphic in the GitHub README; preserve the existing overview hero file. The viewer must grasp the convenience from UI spatial arrangement and visible dragging, with almost no explanatory prose.
INPUT ROLES:
Image 1 (orbit-overview.png) is STYLE / BRAND reference: warm ivory, forest green, sage, subtle paper texture, restrained pastel task accents and calm editorial illustration. Preserve the recognizable IIh orbit mark only as a small app corner brand.
Image 2 (demo-month.jpg) is a REFERENCE for the real monthly workspace structure and visual language, not an edit target.
Image 3 (demo-week.jpg) is a REFERENCE for the real weekly workspace structure and visual language, not an edit target.
COMPOSITION:
Make one clean landscape illustration about 16:11, high resolution. A compact title along the top. Below it TWO LARGE, very legible application-window vignettes stacked vertically, with generous gutters and identical main-workspace + RIGHT-SIDEBAR geometry. Use near-front-on, modest perspective only; UI readability matters. The upper scene is a monthly calendar with the Gmail right sidebar open. The lower scene is a weekly time grid with the Drive files right sidebar open. A window is not a floating source-card flowchart. This is not a table, three-column workflow, numbered tutorial, or paragraphs of explanation.
UPPER WINDOW / MONTH + GMAIL:
Small IIh Orbit mark in the upper left, calendar view tabs with 月視圖 selected. The large LEFT/main area shows a full seven-day monthly calendar. Inside the SAME calendar cells, include several fixed pale-blue Google events visibly marked G, together with forest/sage Orbit task chips marked with a small circular dot. Two small source-toggle chips above the calendar show 'G Google 月曆' and '● Orbit 任務' both active. These Google events already live in the calendar grid; do not draw a separate Calendar source panel outside the workspace.
On the RIGHT, a normal attached Gmail sidebar with an envelope tab active and a file tab inactive. Show two short fictional email cards. The selected email is titled '場地確認'. Show the visual action of dragging FROM that right sidebar TO an empty monthly date cell: original email card still in the sidebar, a slightly translucent duplicate email card halfway across the boundary, a large clear arrow cursor touching that ghost card, and one gently curved dotted motion trail ending at a dashed rounded green drop target in the empty calendar cell. Inside that target is the newly created Orbit task chip '場地確認' with a small chain/envelope badge, so the source and result are visually the same item. Arrow direction must go RIGHT TO LEFT from sidebar into main calendar. Do not cover the fixed blue Google event chips.
LOWER WINDOW / WEEK + DRIVE:
Same application structure, with 週視圖 selected. Main area is a complete seven-day weekly time grid, showing hours and several pastel time blocks. In the SAME weekly grid, show blue Google events marked G and sage Orbit tasks with dots. Both source toggles active again. RIGHT sidebar is the attached Drive files panel with its file/folder tab active and envelope tab inactive, showing two or three fictional file rows, one titled '活動流程.pdf'. Visually drag that file FROM the right sidebar INTO an empty weekly time slot: file remains in list, translucent file-card duplicate at boundary, obvious arrow cursor, a gently curved dotted motion trail pointing RIGHT TO LEFT to an outlined green time slot holding the newly created task '活動流程.pdf', with a small chain/file badge. This is the SECOND and only other drag trail.
CALENDAR COPY BEHAVIOR:
Google Calendar is NEVER dragged. In a small, visually secondary activity-detail popover anchored to one blue G event within the upper monthly calendar, show a neat button with the exact text '複製為 Orbit 任務'. No drag ghost, no motion arrow, no trail and no drop target should originate from a G event or from this popover. This is an on-screen button action; not another drag source. Keep the rest of this popover minimal: short 'Google 活動' header, no explanatory paragraph. It should not obscure the Gmail-to-date drag.
TEXT:
Only these short, exact Traditional Chinese UI phrases plus small illustrative dates/hours are allowed:
Main title: '日程、郵件、檔案，都在任務旁'
Window labels: '月視圖 × Gmail', '週視圖 × Drive'
'IIh Orbit', '月視圖', '週視圖', 'Gmail', 'Drive', 'G Google 月曆', '● Orbit 任務', '場地確認', '活動流程.pdf', 'Google 活動', '複製為 Orbit 任務', '新任務'
No prose captions, no numbered explanations, no dense task text, no invented toolbar features.
STYLE:
Clear fine borders, rounded panels, subtle dimensional shadows, warm ivory background, deep green typography, pale blue Google blocks vs sage/pastel Orbit blocks. Use envelope, calendar and document icons consistently. User should see one workspace that already combines calendars and tasks, with convenient source panels immediately beside it. Ample white space. Professional and gentle, no rockets, no cartoon people, no giant central logo distracting from actions.
INVARIANTS:
Calendar events are integrated into BOTH monthly and weekly views; email and files come ONLY from RIGHT sidebars, one active sidebar tab per window. Only email and Drive files are dragged. Preserve source item identity in the task created from it. No arrows between task cards, no Gantt dependency lines, no autonomous synchronization animation, no claim of Calendar drag or permanent Calendar source linkage. This is a conceptual illustration, not a real screenshot.
```
