# 任務導向的文件連結空間站示意圖

製作方式：內建 imagegen。此圖為概念插畫，非實際 App 截圖。

參考圖片為 `workspace-integration.png`、`orbit-overview.png` 與 `demo-month.jpg`。新圖另存為 `docs/images/task-link-station.png`，保留先前版本。標題沿用 App 左側欄的「任務導向的文件連結空間站」。

## 生成提示詞

```text
Use case: ui-mockup / ads-marketing.
Create a NEW simplified feature illustration for the Traditional Chinese productivity app IIh Orbit. The user found a six-window 3x2 matrix too busy and explicitly DOES NOT want separate Gmail and Drive columns. They preferred the earlier design where a Google activity detail was visibly attached to the monthly calendar. Preserve all existing image files and make a new version.
REFERENCES:
Image 1 workspace-integration.png is the useful reference for the calm style, monthly/weekly integrated Google activities, right sidebar drag, and Google activity copy popover. Its upper monthly scene is the strongest structural reference.
Image 2 orbit-overview.png is a brand and color reference: deep forest green, ivory, sage, restrained pastels, small recognizable IIh orbit mark.
Image 3 demo-month.jpg is the actual app's monthly UI structure reference, NOT an edit target.
DESIGN GOAL:
ONE elegant large app-window scene, near-front-on, landscape about 16:10. Clear and quiet, plenty of breathing room. Convey in the image: Google activities are already inside the main month view; email/files live beside the workspace and can be dragged into tasks; the view and sidebar are independently switchable. Do not multiply windows to demonstrate combinations.
TITLE EXACTLY:
任務導向的文件連結空間站
Use this as the large main title above the one scene. No additional slogan, paragraph or large explanatory labels.
SINGLE APP STRUCTURE:
A small IIh Orbit logo in the app's upper-left. A slim left navigation rail only. One large main calendar canvas occupies about 72-76% of the scene; ONE attached right sidebar occupies the remaining 24-28%.
At the top of the MAIN area, show a clear three-option view switcher with small recognizable icons and exact labels 看板, 月視圖, 週視圖. 月視圖 is selected; the other two are visible choices. These controls are independent from the sidebar controls at the far right. Do not write month+Gmail or week+Drive pair labels.
MAIN MONTHLY CALENDAR:
Show a recognizable seven-day month grid with small illustrative dates and a few uncluttered cards. Integrate several BLUE Google activity chips marked G directly among sage/green Orbit task chips inside the SAME month grid. Two small active source toggles above the calendar: G Google 月曆 and ● Orbit 任務. Calendar must feel integrated, not a detached service icon.
GOOGLE CALENDAR AS A MAJOR FOCUS:
Select one blue G activity in the LEFT/MIDDLE part of the month grid. Open a modest activity-detail popover immediately BESIDE that selected event, with its small pointer/nub visibly attached to that exact blue event chip. The popover's short header is Google 活動; show a small blue calendar/G icon and one clearly readable primary button with the exact text 複製為 Orbit 任務.
This popover is inside the visual calendar area, not at the bottom of the overall picture, not in a footer, not floating with no anchor. Keep it comfortably large enough that the copy button is legible. No arrows, ghosts or drag cursor originate from a Google activity. Calendar remains a button-copy action.
ONE RIGHT SIDEBAR, TWO ALTERNATIVE TABS:
At the top of the same right sidebar, show a segmented Gmail / Drive tab switcher with an envelope icon and document/folder icon, and a small subtle swap/flip cue between the choices. Gmail is the foreground selected tab.
To convey that Drive is the alternative in the SAME sidebar without separate columns, use a very small, tasteful layered-card/flip-deck metaphor INSIDE the sidebar's footprint: one full foreground Gmail card titled 場地確認; one partially revealed, subtly offset background file card titled 活動流程.pdf with a Drive/file icon, clearly looking like the alternate tab's preview rather than a mixed simultaneous inbox. This should take the space of one compact card stack, not two independently titled source sections. No separate Gmail app window, no separate Drive app window, no duplicated calendars. The two source choices must not each receive a column.
DRAG ACTION, SECOND MAJOR FOCUS:
Show ONE compact translucent email card titled 場地確認 hovering just LEFT of the right-sidebar boundary with one clear dark-green arrow cursor on it. A single gentle dotted curved motion trail goes RIGHT TO LEFT from the selected sidebar mail, across a short distance into an empty DATE CELL. The endpoint is a pale-green Orbit task chip titled 場地確認 inside a dashed rounded drop outline, with a tiny chain/envelope badge. The source card remains visible in the sidebar. This one clear action represents the source-panel-to-workspace gesture; the Drive preview and independently switchable tab show that files use the same source-panel pattern. Do not create six drag examples or multiple intersecting arrows. Keep the selected Google activity/popover far enough away from this drag that they are unmistakably two distinct operations.
WORDS ALLOWED:
任務導向的文件連結空間站, IIh Orbit, 看板, 月視圖, 週視圖, Gmail, Drive, G Google 月曆, ● Orbit 任務, Google 活動, 複製為 Orbit 任務, 場地確認, 活動流程.pdf. Small illustrative dates and a couple of UI glyphs are fine. Prefer quiet lines and icons instead of dense microtext. Correct Traditional Chinese, never Simplified.
STYLE:
Same premium calm editorial UI illustration as references: warm ivory, forest green #234a40/#31584b, pale sage, clearly identifiable pale blue Google blocks, restrained lavender/apricot accents, fine borders, subtle soft shadows, slight paper texture, unobtrusive orbit motif at the margins. The UI itself should be dominant and tidy; very little decoration. Maintain large readable controls and hierarchy.
INVARIANTS:
Exactly ONE primary app window and ONE right sidebar. No Gmail/Drive two-column comparison. No 3x2 matrix, no six miniature windows, no wall of explanatory text. Google Calendar data visible directly IN the month view and its copy popover physically anchored to a blue event. No Calendar drag. No task dependency arrows or bidirectional-sync claims. Preserve independent view tabs and sidebar tabs. This is a conceptual illustration, not an actual screenshot.
```
