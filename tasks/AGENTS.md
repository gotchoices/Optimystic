The tasks folder contains fix, plan, implement, review, blocked, and complete subfolders.  Each task is an md file under these folders, having a descriptive filename prefixed with a 1-5 priority (5 being highest priority).  

You own the full stage transition.  When you are done:
  1. Create the next-stage output file(s) in the appropriate tasks/ subfolder.
     You may split one task into multiple next-stage tasks if warranted.
     You may keep or adjust the priority prefix as appropriate.
  2. Delete the original source task file from its current stage folder.
* **Important**: Only proceed if you are clear on the task after research.  If there are questions or important decisions, transition the task into the blocked/ folder, with appropriate question(s) and/or discussion of tradeoffs.

Stages:
- Fix - for bugs.  Start with a reproducing test case, or a trace modality if the issue is intermittent.  Once reproduced and researched, form one or more hypothesis as to the cause and correction.  Provided enough confidence, output is one or more implementation task file(s) in implement/.  References should be made to key files and documentation.  TODO sub-tasks should be at the bottom of the task file(s).  Split into multiple tasks if warranted.
- Plan - for features and enhancements.  After research, provided no major questions/options remain, output is one or more design and implement/ tasks.  References should be made to key files and documentation.  TODO sub-tasks should be at the bottom of the task file(s).  Don't switch to your agent's "planning mode" when working these tasks - that's too meta.  After planning, you may immediately proceed to implement iif: * the plan is concrete; * you haven\'t filling your context with a bunch of bunny trails (context is fresh); * no unresolved design questions remain; * the task doesn't indicate otherwise.
- Implement - These tasks are ready for implementation (fix, build, update, ...whatever the task specifies).  If more than one agent would be useful, without stepping on toes, spawn sub-agents.  Be sure the build and tests pass when done. Once complete, output a distilled summary of the task, with emphasis on testing, validation and usage into the review/ folder and delete the task from implement/.
- Review - Inspect the code against all aspect-oriented criteria (SPP, DRY, modular, scalable, maintainable, performant, etc.).  Ensure there are tests for the task, and that the build and tests pass.  Try to look only at the interface points for the task initially to avoid biasing the tests towards the implementation.  Ensure that relevant docs are up-to-date.  Output to complete/ once the tests pass and code is solid.

Don't combine tasks unless they are tightly related.

For new tasks: put a new file into fix/ or plan/ but focus on the description/requirements of the issue or feature, expected behavior, use case, etc.  Don't do planning, add TODO items, or get ahead, unless you already posess key information that would be useful.

Task file template:
----
description: <brief description>
dependencies: <needed other tasks, modularity points, external libraries>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if applicable: TODO list of sub-tasks - avoid numbering of tasks, besides phases>
