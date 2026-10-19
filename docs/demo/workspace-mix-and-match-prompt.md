# 視圖與側欄自由搭配示意圖

製作方式：內建 imagegen。此圖為概念插畫，非實際 App 截圖。

參考圖片為 `workspace-integration.png`、`demo-board.jpg` 與 `orbit-overview.png`。新圖另存為 `docs/images/workspace-mix-and-match.png`，保留上一版及原形象圖。

## 生成提示詞

```text
Use case: infographic-diagram / ui-mockup.
Create a NEW revised feature illustration for the Traditional Chinese app IIh Orbit. The user likes the attached existing illustration but says showing only month+Gmail and week+Drive incorrectly suggests fixed pairings. The new image MUST visually demonstrate that views and sidebars are INDEPENDENT choices, and must include the kanban board too. Preserve the original files; this is a new version.
REFERENCE ROLES:
Image 1 workspace-integration.png: visual style, main-workspace plus RIGHT sidebar layout, Google/Orbit combined calendars, translucent drag ghost, cursor and dotted right-to-left motion path.
Image 2 demo-board.jpg: real four-column kanban structure and task card design. This is a UI reference, not an edit target.
Image 3 orbit-overview.png: palette and restrained brand mood.
CORE DESIGN, NON-NEGOTIABLE:
One polished high-resolution landscape 4:3 overview, preferably about 2560x1920 or larger. A large but compact title at the top. Under it a balanced THREE ROWS x TWO COLUMNS arrangement of SIX illustrated app windows. This is a visual matrix of miniature app scenes, not a table of sentences, not a flowchart of source icons. All SIX windows must be present.
Two clear short column headers above the window grid: envelope icon + Gmail on LEFT column, document/folder icon + Drive on RIGHT column.
Three slim visual row labels beside the rows, with icons: 看板, 月視圖, 週視圖.
The six scenes are exactly:
top-left KANBAN + GMAIL; top-right KANBAN + DRIVE;
middle-left MONTH + GMAIL; middle-right MONTH + DRIVE;
bottom-left WEEK + GMAIL; bottom-right WEEK + DRIVE.
This complete 3x2 matrix is what makes the mix-and-match behavior visually unambiguous. Never omit an example or swap the row order. Windows in a row have the same underlying view, and each column uses its named source.
APP WINDOW STRUCTURE:
Every miniature window has a slim common header with a small recognizable IIh orbit brand mark, a main canvas on the LEFT taking about 72% width, and an ATTACHED right sidebar taking about 28%. The main view tabs visibly offer 看板, 月, 週, with the row's view active. The sidebar visibly offers envelope/Gmail and document/Drive tabs, exactly ONE active in each window, matching its column. Do not show Gmail and Drive contents simultaneously in one sidebar. View choice and sidebar choice must look like separate controls in different places, so viewers understand either can be switched independently.
DRAG ACTIONS IN ALL SIX SCENES:
In all LEFT-column sidebars, show a selected email titled 場地確認 plus one quiet other email row. A semi-transparent copy of the selected email floats by the sidebar boundary, with a clearly visible dark green arrow cursor. One simple dotted curved motion trail moves RIGHT TO LEFT into an EMPTY main-canvas landing spot, where a green task card/block titled 場地確認 appears inside a dashed drop outline, with a small envelope/chain badge. The original email remains in the sidebar.
In all RIGHT-column sidebars, show a selected file titled 活動流程.pdf plus one quiet other file row. Use the same drag visual from that right sidebar into the main canvas, landing on a new green task titled 活動流程.pdf with a file/chain badge. The original file remains in the sidebar.
Use the SAME email subject across the three Gmail examples and SAME filename across the three Drive examples. Their reuse across view choices visually reinforces interchangeable views. One drag path per window, six total. Cursor and floating cards must remain clear and not obscure the destination.
KANBAN ROW:
Each canvas has FOUR distinct pastel kanban columns, a few simple task cards, and a highlighted empty insertion spot in one column receiving the dragged source. Column titles may be minimal: 待辦, 進行中, 待審核, 完成. Do not put dates/time grids into the kanban scenes. No dependency lines between tasks.
MONTH ROW:
Each canvas has a recognizable complete seven-day MONTHLY calendar grid, little day numbers, and mixed pale BLUE Google activities visibly marked G alongside sage/green Orbit task chips. These blue G events ALREADY LIVE INSIDE the calendar, interspersed with local task chips. No external Calendar source panel. The dragged mail/file lands in an empty DATE CELL as a green Orbit task. Include small source-toggle icons/chips indicating Google calendar + Orbit tasks are both on.
WEEK ROW:
Each canvas has a recognizable seven-day WEEKLY time-block grid with a left-side hour scale, several timed blocks, and mixed BLUE G Google activities alongside sage/green Orbit tasks. The dragged mail/file lands in an empty TIME SLOT as a green task block. Use the same source-toggle chips.
CALENDAR BEHAVIOR:
Calendar is never a drag source. No blue G activity has a drag ghost or arrow attached. In a small visually separate bottom strip or one secondary Google activity details popover, show a blue calendar/G icon and the exact UI button 複製為 Orbit 任務. This is the only Calendar-to-task creation affordance, an explicit button. Never illustrate Calendar being dragged or tasks depending on each other. Do not let the calendar copy detail compete with the six mix-and-match examples.
WORDS / HIERARCHY:
Main title exactly: 同一個工作空間，自由搭配
Column headers: Gmail, Drive
Row labels: 看板, 月視圖, 週視圖
Short UI text allowed: IIh Orbit, 看板, 月, 週, Gmail, Drive, 待辦, 進行中, 待審核, 完成, 場地確認, 活動流程.pdf, Google 月曆, Orbit 任務, 複製為 Orbit 任務. Small illustrative dates/hours are fine. Prefer icons and quiet placeholder lines to illegible microtext. No long descriptive captions, no explanatory paragraphs, no slogans beyond the one title. Correct Traditional Chinese.
STYLE:
Keep the calm premium illustration style of Image 1: deep forest green #234a40/#31584b, warm ivory background, pale sage UI surfaces, pale blue G activities, restrained lavender/apricot board accents, neat rounded cards and subtle shadows, fine dotted green drag trails. Nearly front-on perspective for maximum readability; small corner brand marks, ample gutter separation, unobtrusive orbit motif at the margins. Avoid excessive decorative leaves occupying the windows, oversized central logo, random icons, people, neon, blur, dense gibberish text.
Quality goal: At a glance, see three view choices crossed with two source choices, with all six sources visibly dragged from right sidebars into the chosen main view. This is a conceptual illustration, not a real screenshot.
```
