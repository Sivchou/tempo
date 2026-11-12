# Tempo

A paper-style school planner for keeping up with classes, SAT prep and competitions. I built it because I was behind on Canvas assignments and needed one place that shows what's late, what's next, and how long it will take to catch up.

**Live:** https://sivchou.github.io/tempo/

## Features

- **Today:** a short summary (days to the SAT, overdue, due today), the next three things to work on, and today's schedule.
- **Tasks:** every to-do in one list, filtered by class, SAT, competitions or personal. Grouped into overdue, today, this week and later.
- **Catch-up plan:** adds up the estimated time for overdue work and shows the date you'll be caught up at your chosen hours per day.
- **Calendar:** month grid and a week view with hourly slots. Tap an empty slot to add an event.
- **Goals:** SAT countdown, daily practice goal, practice-test score trend, and competitions with prep checklists.
- **Focus timer:** start a timer on any task. Time spent is logged to that task and to SAT practice.
- **Canvas import:** import the Canvas calendar feed (`.ics`). Assignments are matched by their Canvas ID, so re-importing updates due dates without duplicating anything or undoing checkmarks.
- **Private accounts:** Google sign-in. Each user's data is stored under their own account and protected by Firestore security rules.
- **Works like an app:** installable to the iPhone home screen, with offline support through Firestore's local cache.

## Tech

- Vanilla HTML, CSS and JavaScript (ES modules), no framework or build step
- Firebase Authentication (Google) and Cloud Firestore
- GitHub Pages for hosting

| File | What it does |
| --- | --- |
| `index.html` | Page structure, sign-in screen, tab bar |
| `style.css` | Paper planner theme with light and dark mode |
| `app.js` | State, rendering, sheets, focus timer, Canvas `.ics` parser, Firestore sync |
| `firebase-config.js` | Firebase project config (public by design) |
| `firestore.rules` | Security rules: users can only read and write `users/{their uid}/...` |

## Data model

```
users/{uid}/classes/{id}   name, color, canvasCode
users/{uid}/tasks/{id}     title, cat, classId, type, date, time, est, done, spent
users/{uid}/events/{id}    title, cat, date, start, end
users/{uid}/comps/{id}     name, date, time, location
users/{uid}/scores/{id}    date, math, rw
users/{uid}/sessions/{id}  date, minutes, cat, taskId
users/{uid}/meta/settings  testDate, goal, satDaily, hoursPerDay
```

## Run your own copy

1. Create a Firebase project. Enable **Authentication → Google** and create a **Firestore** database.
2. Register a web app and paste its config into `firebase-config.js`.
3. Paste `firestore.rules` into **Firestore → Rules** and publish.
4. Add your site's domain under **Authentication → Settings → Authorized domains**.
5. Serve the folder with any static server (for example `python3 -m http.server`) or GitHub Pages.

The Firebase web config is not a secret. Access to data is enforced by the security rules.
