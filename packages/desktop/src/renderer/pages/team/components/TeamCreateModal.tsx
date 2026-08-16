import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Form, Input, Message, Spin } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Close } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import { useSWRConfig } from 'swr';
import { ipcBridge } from '@/common';
import type { TTeam, TeamAgent } from '@/common/types/team/teamTypes';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useConversationAgents } from '@renderer/pages/conversation/hooks/useConversationAgents';
import { DETECTED_AGENTS_SWR_KEY } from '@renderer/utils/model/agentTypes';
import AionModal from '@renderer/components/base/AionModal';
import { WorkspaceFolderSelect } from '@renderer/components/workspace';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import {
  agentKey,
  agentFromKey,
  resolveConversationType,
  resolveTeamAgentType,
  filterUserVisibleTeamLeaderAgents,
  AgentOptionLabel,
  cliAgentToOption,
  assistantToOption,
} from './agentSelectUtils';
import type { TeamAgentOption } from './agentSelectUtils';
import { resolveDefaultTeamAgentModel } from './teamCreateModelResolver';

// [E2E SYNC] 修改此组件的 DOM 结构（class、标题、关闭按钮等）时，
// 必须同步更新 tests/e2e/cases/teams/team-create.e2e.ts 和 team-whitelist.e2e.ts 中的 selector，
// 并立即向上汇报改动情况。
const FormItem = Form.Item;

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (team: TTeam) => void;
};

const AgentRadioRow: React.FC<{
  agent: TeamAgentOption;
  isSelected: boolean;
  onClick: () => void;
}> = ({ agent, isSelected, onClick }) => (
  <button
    type='button'
    role='radio'
    aria-checked={isSelected}
    className={`flex w-full cursor-pointer items-center gap-12px border-none bg-transparent rounded-8px px-12px py-9px text-left transition-colors ${
      isSelected ? 'bg-[var(--eve-row-selected-bg)]' : 'hover:bg-fill-2'
    }`}
    style={isSelected ? { boxShadow: 'inset 0 0 0 1px var(--eve-focus-ring)' } : undefined}
    onClick={onClick}
    data-testid={`team-create-agent-option-${agentKey(agent)}`}
  >
    <div
      className='h-16px w-16px flex-shrink-0 rounded-full transition-all'
      style={{
        boxSizing: 'border-box',
        border: isSelected ? '5px solid var(--eve-focus-ring)' : '1.5px solid var(--color-border-3)',
      }}
    />
    <div className='flex-1 overflow-hidden'>
      <AgentOptionLabel agent={agent} />
    </div>
  </button>
);

const TeamCreateModal: React.FC<Props> = ({ visible, onClose, onCreated }) => {
  const { t } = useTranslation();
  const { mutate: mutateSWR } = useSWRConfig();
  const { user } = useAuth();
  const { cliAgents, presetAssistants, isLoading: agentsLoading } = useConversationAgents();
  const [name, setName] = useState('');
  const [dispatchAgentKey, setDispatchAgentKey] = useState<string | undefined>(undefined);
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(false);
  const [assistantRefreshInFlight, setAssistantRefreshInFlight] = useState(false);
  const [freshPresetAssistants, setFreshPresetAssistants] = useState<Assistant[] | null>(null);
  const nameInputRef = useRef<RefInputType | null>(null);

  const cliAgentOptions = useMemo(() => cliAgents.map(cliAgentToOption), [cliAgents]);
  const teamCapableKeys = useMemo(
    () =>
      new Set(
        cliAgents
          .filter((a) => a.team_capable)
          .flatMap((a) => [a.id, a.backend, a.agent_type].filter(Boolean) as string[])
      ),
    [cliAgents]
  );
  const presetAssistantOptions = useMemo(
    () => (freshPresetAssistants ?? presetAssistants).map((a) => assistantToOption(a, teamCapableKeys)),
    [freshPresetAssistants, presetAssistants, teamCapableKeys]
  );
  const allAgents = useMemo(
    () => filterUserVisibleTeamLeaderAgents([...cliAgentOptions, ...presetAssistantOptions]),
    [cliAgentOptions, presetAssistantOptions]
  );

  useEffect(() => {
    if (visible) {
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setAssistantRefreshInFlight(true);

    // Fresh installs seed the managed EVE assistant three seconds after the
    // window appears. A modal opened before that seed used to cache an empty
    // assistant list for the whole session. Reuse the idempotent MAIN bootstrap,
    // then refresh both shared sources once; no raw worker is exposed.
    void ipcBridge.commandEve.ensureAssistant
      .invoke()
      .then(async (result) => {
        if (cancelled || !result?.success) return;
        const [detectedAgents, assistants] = await Promise.all([
          mutateSWR(DETECTED_AGENTS_SWR_KEY),
          ipcBridge.assistants.list.invoke(),
        ]);
        void detectedAgents;
        if (cancelled) return;
        const enabledAssistants = assistants.filter((assistant) => assistant.enabled !== false);
        setFreshPresetAssistants(enabledAssistants);
        await mutateSWR('assistants.presets', enabledAssistants, false);
      })
      .catch((): void => undefined)
      .finally(() => {
        if (!cancelled) setAssistantRefreshInFlight(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, mutateSWR]);

  useEffect(() => {
    if (!visible) return;
    const nextAgentKey = allAgents[0] ? agentKey(allAgents[0]) : undefined;
    setDispatchAgentKey((current) =>
      current && allAgents.some((agent) => agentKey(agent) === current) ? current : nextAgentKey
    );
  }, [visible, allAgents]);

  const handleClose = () => {
    setName('');
    setDispatchAgentKey(undefined);
    setWorkspace('');
    onClose();
  };

  const handleSelectLeader = (key: string) => {
    setDispatchAgentKey(key);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      Message.warning(t('team.create.nameRequired', { defaultValue: 'Please enter a team name' }));
      nameInputRef.current?.focus();
      return;
    }
    if (!dispatchAgentKey) {
      Message.warning(t('team.create.leaderRequired', { defaultValue: 'Please select a team leader' }));
      return;
    }
    const user_id = user?.id ?? 'system_default_user';
    setLoading(true);
    try {
      const agents: TeamAgent[] = [];

      const dispatchAgent = dispatchAgentKey ? agentFromKey(dispatchAgentKey, allAgents) : undefined;
      const dispatchAgentType = resolveTeamAgentType(dispatchAgent, 'acp');
      const dispatchConversationType = resolveConversationType(dispatchAgentType);
      const resolvedModel = await resolveDefaultTeamAgentModel({
        agent_type: dispatchAgentType,
        conversation_type: dispatchConversationType,
      });
      agents.push({
        slot_id: '',
        conversation_id: '',
        role: 'leader',
        status: 'pending',
        agent_type: dispatchAgentType,
        agent_name: 'Leader',
        conversation_type: dispatchConversationType,
        custom_agent_id: dispatchAgent?.id,
        model: resolvedModel,
      });

      const team = await ipcBridge.team.create.invoke({
        user_id,
        name,
        workspace,
        workspace_mode: 'shared',
        agents,
      });

      // The platform bridge swallows provider errors and returns a sentinel object
      const result = team as unknown as { __bridgeError?: boolean; message?: string };
      if (result.__bridgeError) {
        Message.error(getConversationCreateErrorMessage(result.message ?? t('team.create.error'), t));
        return;
      }

      onCreated(team);
      handleClose();
    } catch (error) {
      Message.error(getConversationCreateErrorMessage(error, t));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AionModal
      visible={visible}
      onCancel={handleClose}
      className='team-create-modal'
      style={{ width: 560 }}
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
      autoFocus={false}
      unmountOnExit={false}
      footerUnpadded
      contentStyle={{
        background: 'transparent',
        padding: 0,
        overflow: 'hidden',
      }}
      header={{
        render: () => (
          <div className='flex items-center justify-between border-b border-[var(--glass-overlay-border)] px-24px py-18px'>
            <h3 className='m-0 text-16px font-600 text-t-primary'>
              {t('team.create.title', { defaultValue: 'Create Team' })}
            </h3>
            <Button
              type='text'
              icon={<Close size='18' fill='currentColor' className='text-t-secondary' />}
              onClick={handleClose}
              aria-label={t('common.close', { defaultValue: 'Close' })}
              className='!h-28px !w-28px !min-w-28px !p-0 !rd-8px hover:!bg-fill-2'
            />
          </div>
        ),
      }}
      footer={
        <div className='flex justify-end gap-10px border-t border-[var(--glass-overlay-border)] px-24px py-16px'>
          <Button
            onClick={handleClose}
            className='min-w-80px'
            style={{ borderRadius: 8 }}
            data-testid='team-create-cancel'
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type='primary'
            onClick={handleCreate}
            loading={loading}
            disabled={!name.trim() || !dispatchAgentKey}
            className='min-w-80px'
            style={{ borderRadius: 8 }}
          >
            {t('team.create.confirm', { defaultValue: 'Create Team' })}
          </Button>
        </div>
      }
    >
      <div className='px-24px py-20px' style={{ maxHeight: 'min(72vh, 640px)', overflowY: 'auto' }}>
        <Form layout='vertical'>
          {/* Team name */}
          <FormItem
            label={
              <span className='text-12px font-500 text-t-secondary'>
                {t('team.create.namePlaceholder', { defaultValue: 'Team name' })}
                <span className='ml-4px text-danger-6'>*</span>
              </span>
            }
          >
            <Input
              ref={nameInputRef}
              placeholder={t('team.create.namePlaceholder', { defaultValue: 'Team name' })}
              value={name}
              onChange={setName}
              data-testid='team-create-name-input'
            />
          </FormItem>

          {/* Team Leader */}
          <FormItem
            label={
              <div className='flex flex-col gap-2px'>
                <span className='text-12px font-500 text-t-secondary'>
                  {t('team.create.step.dispatch', { defaultValue: 'Team Leader' })}
                  <span className='ml-4px text-danger-6'>*</span>
                </span>
                <span className='text-11px font-normal leading-16px text-t-tertiary'>
                  {t('team.create.leaderDesc', {
                    defaultValue: 'Receives your instructions and spawns teammates as needed during the conversation',
                  })}
                </span>
              </div>
            }
          >
            {allAgents.length === 0 && (agentsLoading || assistantRefreshInFlight) ? (
              <div className='flex items-center justify-center gap-8px rounded-8px border border-dashed border-[var(--glass-overlay-border)] bg-transparent py-20px text-12px text-t-tertiary'>
                <Spin size={18} />
                {t('team.create.preparingLeader')}
              </div>
            ) : allAgents.length === 0 ? (
              <div className='flex items-center justify-center rounded-8px border border-dashed border-[var(--glass-overlay-border)] bg-transparent py-20px text-12px text-t-tertiary'>
                {t('team.create.noSupportedAgents', { defaultValue: 'No supported agents installed' })}
              </div>
            ) : (
              <div className='relative flex flex-col gap-8px'>
                <div
                  className='max-h-320px overflow-y-auto rounded-8px border border-[var(--glass-overlay-border)] bg-transparent p-6px'
                  data-testid='team-create-leader-select'
                  role='radiogroup'
                >
                  {allAgents.map((agent) => {
                    const key = agentKey(agent);
                    return (
                      <AgentRadioRow
                        key={key}
                        agent={agent}
                        isSelected={dispatchAgentKey === key}
                        onClick={() => handleSelectLeader(key)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </FormItem>

          {/* Project / Workspace */}
          <FormItem
            label={
              <span className='text-12px font-500 text-t-secondary'>
                {t('team.create.step.workspace', { defaultValue: 'Project' })}
                <span className='ml-4px text-11px font-normal text-t-tertiary'>
                  {t('common.optional', { defaultValue: '(optional)' })}
                </span>
              </span>
            }
          >
            <WorkspaceFolderSelect
              value={workspace}
              onChange={setWorkspace}
              placeholder={t('team.create.selectFolder', { defaultValue: 'Select folder' })}
              input_placeholder={t('team.create.workspacePlaceholder', {
                defaultValue: 'Project folder path (optional)',
              })}
              recentLabel={t('team.create.recentLabel', { defaultValue: 'Recent' })}
              chooseDifferentLabel={t('team.create.chooseDifferentFolder', {
                defaultValue: 'Choose a different folder',
              })}
              triggerTestId='team-create-workspace-trigger'
              menuTestId='team-create-workspace-menu'
            />
          </FormItem>
        </Form>
      </div>
    </AionModal>
  );
};

export default TeamCreateModal;
