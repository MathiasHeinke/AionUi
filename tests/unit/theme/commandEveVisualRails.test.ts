import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(process.cwd(), 'packages/desktop/src/renderer');
const read = (relativePath: string): string => fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');

const collectSourceFiles = (directory: string): string[] => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(absolutePath);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
};

describe('Command EVE visual rails', () => {
  it('keeps public renderer consumers off the legacy AOU palette', () => {
    const allowed = new Set([
      path.join(rendererRoot, 'styles/themes/default-color-scheme.css'),
      path.join(rendererRoot, 'styles/themes/README.md'),
      path.join(rendererRoot, 'styles/MIGRATION.md'),
    ]);
    const presetRoot = path.join(rendererRoot, 'pages/settings/AppearanceSettings/presets');
    const offenders = collectSourceFiles(rendererRoot).filter((file) => {
      if (allowed.has(file) || file.startsWith(presetRoot)) return false;
      return fs.readFileSync(file, 'utf8').includes('--aou-');
    });

    expect(offenders).toEqual([]);
  });

  it('uses one blur owner for search and no blur per pill', () => {
    const visualCss = read('styles/themes/command-eve-visual.css');
    const pillBlock = visualCss.match(/\.eve-pill \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const searchCss = read('pages/conversation/GroupedHistory/ConversationSearchPopover.css');
    const innerBlock = searchCss.match(/\.conversation-search-modal__panel \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(pillBlock).not.toContain('backdrop-filter');
    expect(searchCss).toContain('backdrop-filter: var(--glass-overlay-filter);');
    expect(innerBlock).toContain('backdrop-filter: none;');
  });

  it('routes legacy and composed modals through explicit EVE dialog owners', () => {
    const aionModal = read('components/base/AionModal.tsx');
    const modalWrapper = read('components/base/ModalWrapper.tsx');
    const overrideCss = read('styles/arco-override.css');

    expect(aionModal).toContain('aionui-modal--composed');
    expect(aionModal).toContain('aionui-modal-wrapper eve-dialog');
    expect(modalWrapper).toContain('aionui-modal--legacy');
    expect(overrideCss).toContain('.arco-modal.aionui-modal--legacy');
    expect(overrideCss).toContain('background: var(--glass-overlay-bg) !important;');
  });

  it('keeps confirm and composed dialogs on the shared glass spacing contract', () => {
    const aionModal = read('components/base/AionModal.tsx');
    const overrideCss = read('styles/arco-override.css');

    expect(overrideCss).toContain('.arco-modal.arco-modal-simple {');
    expect(overrideCss).toContain('.arco-modal.arco-modal-simple .arco-modal-content {');
    expect(aionModal).toContain('px-24px pt-20px pb-16px');
    expect(aionModal).toContain("contentStyle?.padding ?? '4px 24px 20px'");
    expect(aionModal).toContain("!footerUnpadded && 'px-24px pt-16px pb-20px'");
    expect(aionModal).toContain("<div className='flex flex-wrap justify-end gap-10px'>");
  });

  it('keeps prompt icons in a stable column with breathing room', () => {
    const guidCss = read('pages/guid/index.module.css');
    const overrideCss = read('styles/arco-override.css');
    const visualCss = read('styles/themes/command-eve-visual.css');
    const rowBlock = guidCss.match(/\.assistantPromptRow \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(rowBlock).toContain('display: grid !important;');
    expect(rowBlock).toContain('grid-template-columns: 24px minmax(0, 1fr) 20px;');
    expect(rowBlock).toContain('column-gap: 12px;');
    expect(guidCss).toContain('display: contents;');
    expect(guidCss).toContain('gap: 10px;');
    expect(overrideCss).toContain('column-gap: 8px;');
    expect(overrideCss).toContain('.agent-mode-compact-pill > span');
    expect(visualCss).toMatch(/\.company-brain-settings__item-title\.arco-btn \{[\s\S]*?gap: 10px;/);
  });

  it('keeps keyboard focus visible when component event bookkeeping is unavailable', () => {
    const visualCss = read('styles/themes/command-eve-visual.css');

    expect(visualCss).toContain('.eve-composer-surface:has(:focus-visible)');
  });

  it('keeps deep-linked mobile settings routes visible and signals hidden navigation', () => {
    const settingsWrapper = read('pages/settings/components/SettingsPageWrapper.tsx');
    const settingsCss = read('pages/settings/components/settings.css');

    expect(settingsWrapper).toContain(`querySelector<HTMLElement>("[aria-current='page']")?.scrollIntoView?.({`);
    expect(settingsWrapper).toContain('syncMobileNavOverflow');
    expect(settingsCss).toContain('.settings-mobile-top-nav-shell--before .settings-mobile-top-nav');
    expect(settingsCss).toContain('.settings-mobile-top-nav-shell--after .settings-mobile-top-nav');
    expect(settingsCss).toContain('-webkit-mask-image: linear-gradient');
  });

  it('skins toasts with semantic hairlines instead of fixed gradients', () => {
    const overrideCss = read('styles/arco-override.css');
    const messageBlock = overrideCss.slice(overrideCss.indexOf('/* Arco Message custom styles */'));

    expect(messageBlock).toContain('background: var(--glass-overlay-bg) !important;');
    expect(messageBlock).toContain('border-left: 2px solid var(--eve-status-completed) !important;');
    expect(messageBlock).not.toContain('linear-gradient(270deg, #f9fff2');
  });

  it('keeps live chat layers transparent above the shared background material', () => {
    const chatLayout = read('pages/conversation/components/ChatLayout/index.tsx');
    const chatCss = read('pages/conversation/components/ChatLayout/chat-layout.css');

    expect(chatLayout).toContain("className='size-full color-black chat-layout-shell'");
    expect(chatLayout).toContain("className='shrink-0 chat-layout-header-block'");
    expect(chatLayout).toContain('chat-layout-content');
    expect(chatLayout).not.toContain("className='shrink-0 !bg-1'");
    expect(chatCss).toMatch(/\.chat-layout-content\s*\{[\s\S]*?background:\s*transparent !important;/);
  });

  it('uses semantic geometry tiers for controls, overlays and dialogs', () => {
    const visualCss = read('styles/themes/command-eve-visual.css');
    const overrideCss = read('styles/arco-override.css');
    const loginCss = read('pages/registrationGate/RegistrationGatePage.css');
    const aionModal = read('components/base/AionModal.tsx');
    const assistantDrawer = read('pages/settings/AssistantSettings/AssistantEditDrawer.tsx');

    expect(visualCss).toContain('--eve-control-radius: 10px;');
    expect(visualCss).toContain('--eve-overlay-radius: 14px;');
    expect(visualCss).toContain('--eve-dialog-radius: 20px;');
    expect(overrideCss).toContain('border-radius: var(--eve-overlay-radius, 14px) !important;');
    expect(overrideCss).toContain('border-radius: var(--eve-dialog-radius, 20px) !important;');
    expect(aionModal).toContain("contentStyle?.borderRadius || 'var(--eve-dialog-radius)'");
    expect(loginCss).toContain('--registration-control-radius: var(--eve-control-radius, 10px);');
    expect(loginCss).toContain('.registration-gate__field > .arco-input,');
    expect(loginCss).toContain('.registration-gate__field > .arco-input-inner-wrapper,');
    expect(assistantDrawer).toContain("className='eve-assistant-drawer eve-assistant-drawer--right'");
    expect(overrideCss).toContain('.arco-drawer.eve-assistant-drawer--right');
  });

  it('keeps first-step navigation rows transparent in idle and focus states', () => {
    const visualCss = read('styles/themes/command-eve-visual.css');

    expect(visualCss).toContain('--eve-focus-glow:');
    expect(visualCss).toContain('.erste-schritte-settings__step.arco-btn:focus-visible');
    expect(visualCss).toContain('.erste-schritte-settings__step-state .arco-tag');
    expect(visualCss).toMatch(
      /\.erste-schritte-settings__step\.arco-btn\s*\{[\s\S]*?background:\s*transparent !important;/
    );
    expect(visualCss).not.toContain(
      '.erste-schritte-settings__step.arco-btn + .erste-schritte-settings__step.arco-btn'
    );
  });

  it('keeps the desktop account avatar visible in the Command EVE shell', () => {
    const titlebar = read('components/layout/Titlebar/index.tsx');

    expect(titlebar).toContain('{isDesktopRuntime && !layout?.isMobile && (');
    expect(titlebar).toContain("<ProfileAvatar onOpenAccount={() => void navigate('/settings/account')} />");
    expect(titlebar).not.toContain('!COMMAND_EVE_SHELL_ENABLED && isDesktopRuntime && !layout?.isMobile');
  });

  it('renders runtime status as the borderless footer below the chat composer', () => {
    const acpChat = read('pages/conversation/platforms/acp/AcpChat.tsx');
    const runtimeStatus = read('pages/conversation/platforms/acp/AcpRuntimeStatus.tsx');
    const visualCss = read('styles/themes/command-eve-visual.css');
    const siderFooterCss = read('components/layout/Sider/SiderFooter.css');
    const sendBoxPosition = acpChat.indexOf('<AcpSendBox');
    const statusPosition = acpChat.indexOf('<AcpRuntimeStatus');

    expect(sendBoxPosition).toBeGreaterThan(-1);
    expect(statusPosition).toBeGreaterThan(sendBoxPosition);
    expect(runtimeStatus).toContain("className='acp-runtime-status'");
    expect(acpChat).toContain("className='acp-chat flex-1 flex flex-col px-20px min-h-0'");
    expect(visualCss).toContain('--eve-shell-footer-height: 51px;');
    expect(siderFooterCss).toContain('min-height: var(--eve-shell-footer-height, 51px);');
    expect(visualCss).toMatch(/\.acp-chat\s*\{[\s\S]*?overflow-x:\s*clip;/);
    expect(visualCss).toMatch(/\.acp-runtime-status\s*\{[\s\S]*?border:\s*0;/);
    expect(visualCss).toMatch(/\.acp-runtime-status\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(visualCss).toMatch(/\.acp-runtime-status\s*\{[\s\S]*?background:\s*transparent;/);
  });
});
