/**
 * 首页(设计稿):时段问候 + 项目卡片网格(每个项目的任务态汇总)+
 * 「进行中」任务行。数据全部来自已有的 tasks 通道与 projectsStore,
 * 不发额外 RPC。
 */

import React, { useMemo } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useProjectsStore } from '../state/projectsStore.js';
import { useUiStore } from '../state/uiStore.js';
import { openTask } from '../state/actions.js';
import { currentGreetingKey } from '../utils/greeting.js';
import { formatRelativeTime, projectName } from '../utils/format.js';
import { taskTone, toneColorVar, toneLabelKey, type TaskTone } from '../utils/task-tone.js';
import { liveTasks } from '../utils/tasks.js';
import { t, useLocale } from '../i18n/index.js';
import { GitBranchIcon } from './icons.js';

export function HomeView() {
  useLocale();
  const tasks = useDesktopStore((s) => s.tasks);
  const projects = useProjectsStore((s) => s.projects);
  const selectProject = useProjectsStore((s) => s.select);
  const navigate = useUiStore((s) => s.navigate);

  // 口径唯一来源:utils/tasks.ts(与 Sidebar/ArchiveView 共用)。
  const live = useMemo(() => liveTasks(tasks), [tasks]);

  const repos = useMemo(
    () =>
      projects.map((root) => {
        const list = live.filter((task) => task.root === root);
        const running = list.filter((task) => task.isRunning).length;
        const review = list.filter((task) => taskTone(task) === 'review').length;
        const tone: TaskTone = running > 0 ? 'run' : review > 0 ? 'review' : 'draft';
        const state =
          running > 0
            ? t('home.repoRunning', { count: String(running) })
            : review > 0
              ? t('home.repoReview', { count: String(review) })
              : t('home.repoIdle');
        return { root, count: list.length, tone, state };
      }),
    [projects, live],
  );

  const runningTasks = useMemo(() => live.filter((task) => task.isRunning), [live]);
  const reviewCount = useMemo(
    () => live.filter((task) => taskTone(task) === 'review').length,
    [live],
  );

  const open = (taskId: string) => {
    openTask(taskId);
    navigate('task');
  };

  return (
    <div className="home-view">
      <h1 className="home-greeting">{t(currentGreetingKey())}</h1>
      <div className="home-sub">
        {t('home.greetingSuffix', {
          review: String(reviewCount),
          running: String(runningTasks.length),
        })}
      </div>

      <div className="home-section-title">{t('home.repos')}</div>
      {repos.length === 0 ? (
        <div className="home-empty">{t('home.noProjects')}</div>
      ) : (
        <div className="home-repos">
          {repos.map((repo) => (
            <button
              key={repo.root}
              type="button"
              className="repo-card"
              onClick={() => {
                selectProject(repo.root);
                navigate('task');
              }}
            >
              <span className="repo-card-head">
                <GitBranchIcon size={14} />
                <span className="repo-card-name">{projectName(repo.root)}</span>
              </span>
              <span className="repo-card-path">{repo.root}</span>
              <span className="repo-card-state">
                <span className="task-dot" style={{ background: toneColorVar(repo.tone) }} />
                {repo.state}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="home-section-title">{t('home.running')}</div>
      {runningTasks.length === 0 ? (
        <div className="home-empty">{t('sidebar.noTasks')}</div>
      ) : (
        <div className="home-tasks">
          {runningTasks.map((task) => (
            <button key={task.id} type="button" className="home-task-row" onClick={() => open(task.id)}>
              <span className="home-task-title">
                <span className="task-dot" style={{ background: toneColorVar(taskTone(task)) }} />
                {task.title || task.id.slice(0, 8)}
              </span>
              <span className="home-task-project">{projectName(task.root)}</span>
              <span className="home-task-state">{t(toneLabelKey(taskTone(task)))}</span>
              <span className="home-task-when">{formatRelativeTime(task.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
