/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import type { ConfigKeyMap } from '@/common/config/configKeys';
import { removeImageGenerationEnvKeys, resolveImageGenerationMcpEnv } from '@/common/config/imageGenerationMcpEnv';
import {
  DEFAULT_SPEECH_TO_TEXT_CONFIG,
  failClosedSpeechToTextConfig,
  normalizeSpeechToTextConfig,
} from '@/common/config/speechToTextConfigCore';
import { mcpService } from '@/common/adapter/ipcBridge';
import { type IMcpServer, BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from '@/common/config/storage';
import { isImageGenSupported } from '@/common/utils/imageModelAllowlist';
import type { SpeechToTextConfig, SpeechToTextProvider } from '@/common/types/provider/speech';
import { getAgents } from '@/renderer/hooks/agent/useAgents';
import { Form, Tooltip, Message, Button, Dropdown, Menu, Modal, Switch, Input } from '@arco-design/web-react';
import { Down, Help, LinkCloud, Plus } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useConfigModelListWithImage from '@/renderer/hooks/agent/useConfigModelListWithImage';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import AionSelect from '@/renderer/components/base/AionSelect';
import AddMcpServerModal from '@/renderer/pages/settings/components/AddMcpServerModal';
import McpServerItem from '@/renderer/pages/settings/ToolsSettings/McpServerItem';
import { useMcpServers, useMcpConnection, useMcpModal, useMcpServerCRUD, useMcpOAuth } from '@/renderer/hooks/mcp';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import { useNavigate } from 'react-router-dom';

type MessageInstance = ReturnType<typeof Message.useMessage>[0];

const isBuiltinImageGenServer = (server: IMcpServer) =>
  server.builtin === true && (server.id === BUILTIN_IMAGE_GEN_ID || server.name === BUILTIN_IMAGE_GEN_NAME);
const SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT = 'aionui:speech-to-text-config-changed';
const areEnvRecordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
};
const SpeechToTextSettingsSection: React.FC<{
  config: SpeechToTextConfig;
  onChange: (updater: (current: SpeechToTextConfig) => SpeechToTextConfig) => void;
}> = ({ config, onChange }) => {
  const { t } = useTranslation();
  const renderSpeechToTextFieldLabel = useCallback(
    (labelKey: string, requirement: 'required' | 'optional') => (
      <span className='inline-flex items-center gap-6px'>
        <span>{t(labelKey)}</span>
        <span aria-hidden='true' className='text-12px text-t-tertiary'>
          ({t(requirement === 'required' ? 'settings.speechToTextRequired' : 'settings.speechToTextOptional')})
        </span>
      </span>
    ),
    [t]
  );

  const handleProviderChange = useCallback(
    (value: string) => {
      onChange((current) => ({
        ...current,
        provider: value as SpeechToTextProvider,
      }));
    },
    [onChange]
  );

  const handleOpenAIChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['openai']>, value: string) => {
      onChange((current) => ({
        ...current,
        openai: {
          ...current.openai,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  const handleDeepgramChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['deepgram']>, value: string | boolean) => {
      onChange((current) => ({
        ...current,
        deepgram: {
          ...current.deepgram,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  const handleLocalChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['local']>, value: string) => {
      onChange((current) => ({
        ...current,
        local: {
          ...current.local,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  const handleGroqChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['groq']>, value: string) => {
      onChange((current) => ({
        ...current,
        groq: {
          ...current.groq,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  return (
    <SettingsSection
      title={t('settings.speechToText')}
      description={t('settings.speechToTextDescription')}
      action={
        <Switch
          checked={config.enabled}
          onChange={(checked) => {
            onChange((current) => ({ ...current, enabled: checked }));
          }}
        />
      }
    >
      {config.enabled && (
        <Form layout='vertical' className='eve-settings-form'>
          <Form.Item label={t('settings.speechToTextProvider')}>
            <AionSelect value={config.provider} onChange={handleProviderChange}>
              <AionSelect.Option value='local'>{t('settings.speechToTextProviderLocal')}</AionSelect.Option>
              <AionSelect.Option value='groq'>{t('settings.speechToTextProviderGroq')}</AionSelect.Option>
              <AionSelect.Option value='openai'>{t('settings.speechToTextProviderOpenAI')}</AionSelect.Option>
              <AionSelect.Option value='deepgram'>{t('settings.speechToTextProviderDeepgram')}</AionSelect.Option>
            </AionSelect>
          </Form.Item>

          {config.provider === 'local' ? (
            <>
              <div className='text-13px text-t-secondary mb-4px'>{t('settings.speechToTextProviderLocalHint')}</div>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
                <AionSelect
                  value={config.local?.model || DEFAULT_SPEECH_TO_TEXT_CONFIG.local?.model}
                  onChange={(value) => handleLocalChange('model', value)}
                >
                  <AionSelect.Option value='tiny'>tiny (~75 MB)</AionSelect.Option>
                  <AionSelect.Option value='base'>base (~150 MB)</AionSelect.Option>
                  <AionSelect.Option value='small'>small (~500 MB)</AionSelect.Option>
                  <AionSelect.Option value='medium'>medium (~1.5 GB)</AionSelect.Option>
                  <AionSelect.Option value='large-v3'>large-v3 (~3 GB)</AionSelect.Option>
                </AionSelect>
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
                <Input value={config.local?.language} onChange={(value) => handleLocalChange('language', value)} />
              </Form.Item>
            </>
          ) : config.provider === 'groq' ? (
            <>
              <div className='text-13px text-t-secondary mb-4px'>{t('settings.speechToTextProviderGroqHint')}</div>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
                <Input value={config.groq?.model} onChange={(value) => handleGroqChange('model', value)} />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
                <Input value={config.groq?.language} onChange={(value) => handleGroqChange('language', value)} />
              </Form.Item>
            </>
          ) : config.provider === 'openai' ? (
            <>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextApiKey', 'required')}>
                <Input.Password
                  value={config.openai?.api_key}
                  visibilityToggle
                  onChange={(value) => handleOpenAIChange('api_key', value)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextBaseUrl', 'optional')}>
                <Input value={config.openai?.base_url} onChange={(value) => handleOpenAIChange('base_url', value)} />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
                <Input value={config.openai?.model} onChange={(value) => handleOpenAIChange('model', value)} />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
                <Input value={config.openai?.language} onChange={(value) => handleOpenAIChange('language', value)} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextApiKey', 'required')}>
                <Input.Password
                  value={config.deepgram?.api_key}
                  visibilityToggle
                  onChange={(value) => handleDeepgramChange('api_key', value)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextBaseUrl', 'optional')}>
                <Input
                  value={config.deepgram?.base_url}
                  onChange={(value) => handleDeepgramChange('base_url', value)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
                <Input value={config.deepgram?.model} onChange={(value) => handleDeepgramChange('model', value)} />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
                <Input
                  value={config.deepgram?.language}
                  onChange={(value) => handleDeepgramChange('language', value)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextDetectLanguage', 'optional')}>
                <Switch
                  checked={config.deepgram?.detectLanguage !== false}
                  onChange={(checked) => handleDeepgramChange('detectLanguage', checked)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextPunctuate', 'optional')}>
                <Switch
                  checked={config.deepgram?.punctuate !== false}
                  onChange={(checked) => handleDeepgramChange('punctuate', checked)}
                />
              </Form.Item>
              <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextSmartFormat', 'optional')}>
                <Switch
                  checked={config.deepgram?.smartFormat !== false}
                  onChange={(checked) => handleDeepgramChange('smartFormat', checked)}
                />
              </Form.Item>
            </>
          )}
        </Form>
      )}
    </SettingsSection>
  );
};

const ModalMcpManagementSection: React.FC<{
  message: MessageInstance;
  mcpServers: IMcpServer[];
  extensionMcpServers: IMcpServer[];
  setMcpServers: React.Dispatch<React.SetStateAction<IMcpServer[]>>;
  saveMcpServers: (serversOrUpdater: IMcpServer[] | ((prev: IMcpServer[]) => IMcpServer[])) => Promise<void>;
  isPageMode?: boolean;
}> = ({ message, mcpServers, extensionMcpServers, setMcpServers, saveMcpServers, isPageMode }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { oauthStatus, loggingIn, checkOAuthStatus, markLoginRequired, clearLoginRequired, login } = useMcpOAuth();
  const visibleMcpServers = useMemo(
    () => mcpServers.filter((server) => !isBuiltinImageGenServer(server)),
    [mcpServers]
  );

  const handleAuthRequired = useCallback(
    (server: IMcpServer) => {
      markLoginRequired(server.id);
    },
    [markLoginRequired]
  );
  const handleAuthResolved = useCallback(
    (server: IMcpServer) => {
      clearLoginRequired(server.id);
    },
    [clearLoginRequired]
  );

  const { testingServers, handleTestMcpConnection, handleTestMcpConnections } = useMcpConnection(
    setMcpServers,
    message,
    handleAuthRequired,
    handleAuthResolved
  );
  const {
    showMcpModal,
    editingMcpServer,
    deleteConfirmVisible,
    serverToDelete,
    mcpCollapseKey,
    showAddMcpModal,
    showEditMcpModal,
    hideMcpModal,
    showDeleteConfirm,
    hideDeleteConfirm,
    toggleServerCollapse,
  } = useMcpModal();
  const { handleAddMcpServer, handleBatchImportMcpServers, handleEditMcpServer, handleDeleteMcpServer } =
    useMcpServerCRUD(saveMcpServers);

  const handleOAuthLogin = useCallback(
    async (server: IMcpServer) => {
      const result = await login(server);

      if (result.success) {
        message.success(`${server.name}: ${t('settings.mcpOAuthLoginSuccess') || 'Login successful'}`);
        void handleTestMcpConnection(server);
      } else {
        message.error(`${server.name}: ${result.error || t('settings.mcpOAuthLoginFailed') || 'Login failed'}`);
      }
    },
    [login, message, t, handleTestMcpConnection]
  );

  const wrappedHandleAddMcpServer = useCallback(
    async (serverData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>) => {
      const addedServer = await handleAddMcpServer(serverData);
      if (addedServer) {
        void handleTestMcpConnection(addedServer, { notify: false });
      }
    },
    [handleAddMcpServer, handleTestMcpConnection]
  );

  const wrappedHandleEditMcpServer = useCallback(
    async (serverToEdit: IMcpServer | undefined, serverData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>) => {
      const updatedServer = await handleEditMcpServer(serverToEdit, serverData);
      if (updatedServer) {
        void handleTestMcpConnection(updatedServer, { notify: false });
      }
    },
    [handleEditMcpServer, handleTestMcpConnection]
  );

  const wrappedHandleBatchImportMcpServers = useCallback(
    async (serversData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>[]) => {
      const addedServers = await handleBatchImportMcpServers(serversData);
      if (addedServers && addedServers.length > 0) {
        await handleTestMcpConnections(addedServers, { concurrency: 4, notify: false });
      }
      return addedServers;
    },
    [handleBatchImportMcpServers, handleTestMcpConnections]
  );

  const [detectedAgents, setDetectedAgents] = useState<Array<{ backend: string; name: string }>>([]);
  const [importMode, setImportMode] = useState<'json' | 'oneclick'>('json');

  useEffect(() => {
    if (COMMAND_EVE_SHELL_ENABLED) return;

    const loadAgents = async () => {
      try {
        const agents = await getAgents();
        setDetectedAgents(
          agents.map((agent) => ({
            backend: agent.backend,
            name: agent.name,
          }))
        );
      } catch (error) {
        console.error('Failed to load agents:', error);
      }
    };
    void loadAgents();
  }, []);

  useEffect(() => {
    const httpServers = mcpServers.filter(
      (s) => s.transport.type === 'http' || s.transport.type === 'sse' || s.transport.type === 'streamable_http'
    );
    if (httpServers.length > 0) {
      httpServers.forEach((server) => {
        void checkOAuthStatus(server);
      });
    }
  }, [mcpServers, checkOAuthStatus]);

  const handleConfirmDelete = useCallback(async () => {
    if (!serverToDelete) return;
    hideDeleteConfirm();
    await handleDeleteMcpServer(serverToDelete);
  }, [serverToDelete, hideDeleteConfirm, handleDeleteMcpServer]);

  const renderAddButton = () => {
    if (COMMAND_EVE_SHELL_ENABLED) {
      return (
        <Button
          type='secondary'
          icon={<LinkCloud size='16' />}
          onClick={() => {
            void navigate('/settings/connectors');
          }}
        >
          {t('settings.toolsManageConnections')}
        </Button>
      );
    }

    if (detectedAgents.length > 0) {
      return (
        <Dropdown
          trigger='click'
          droplist={
            <Menu>
              <Menu.Item
                key='json'
                onClick={(e) => {
                  e.stopPropagation();
                  setImportMode('json');
                  showAddMcpModal();
                }}
              >
                {t('settings.mcpImportFromJSON')}
              </Menu.Item>
              <Menu.Item
                key='oneclick'
                onClick={(e) => {
                  e.stopPropagation();
                  setImportMode('oneclick');
                  showAddMcpModal();
                }}
              >
                {t('settings.mcpOneKeyImport')}
              </Menu.Item>
            </Menu>
          }
        >
          <Button type='outline' icon={<Plus size='16' />} onClick={(e) => e.stopPropagation()}>
            {t('settings.mcpAddServer')} <Down size='12' />
          </Button>
        </Dropdown>
      );
    }

    return (
      <Button
        type='outline'
        icon={<Plus size='16' />}
        onClick={() => {
          setImportMode('json');
          showAddMcpModal();
        }}
      >
        {t('settings.mcpAddServer')}
      </Button>
    );
  };

  return (
    <SettingsSection
      title={COMMAND_EVE_SHELL_ENABLED ? t('settings.toolsConnectedToolsTitle') : t('settings.mcpSettings')}
      description={COMMAND_EVE_SHELL_ENABLED ? t('settings.toolsConnectedToolsDescription') : undefined}
      action={renderAddButton()}
    >
      <div className='min-h-0'>
        {visibleMcpServers.length === 0 && extensionMcpServers.length === 0 ? (
          <div className='eve-settings-notice eve-tools-empty'>
            {COMMAND_EVE_SHELL_ENABLED ? t('settings.toolsNoConnections') : t('settings.mcpNoServersFound')}
          </div>
        ) : (
          <AionScrollArea
            className={classNames('max-h-360px', isPageMode && 'max-h-none')}
            disableOverflow={isPageMode}
          >
            <div className='eve-mcp-server-list'>
              {visibleMcpServers.map((server) => (
                <McpServerItem
                  key={server.id}
                  server={server}
                  isCollapsed={mcpCollapseKey[server.id] || false}
                  isTestingConnection={testingServers[server.id] || false}
                  oauthStatus={oauthStatus[server.id]}
                  isLoggingIn={loggingIn[server.id]}
                  onToggleCollapse={() => toggleServerCollapse(server.id)}
                  onTestConnection={handleTestMcpConnection}
                  onEditServer={showEditMcpModal}
                  onDeleteServer={showDeleteConfirm}
                  onOAuthLogin={handleOAuthLogin}
                />
              ))}
              {extensionMcpServers.map((server) => (
                <McpServerItem
                  key={server.id}
                  server={server}
                  isCollapsed={mcpCollapseKey[server.id] || false}
                  isTestingConnection={false}
                  onToggleCollapse={() => toggleServerCollapse(server.id)}
                  onTestConnection={handleTestMcpConnection}
                  onEditServer={() => {}}
                  onDeleteServer={() => {}}
                  isReadOnly
                />
              ))}
            </div>
          </AionScrollArea>
        )}
      </div>

      <AddMcpServerModal
        visible={showMcpModal}
        server={editingMcpServer}
        existingServerNames={mcpServers.map((server) => server.name)}
        onCancel={hideMcpModal}
        onSubmit={
          editingMcpServer
            ? (serverData) => wrappedHandleEditMcpServer(editingMcpServer, serverData)
            : wrappedHandleAddMcpServer
        }
        onBatchImport={wrappedHandleBatchImportMcpServers}
        importMode={importMode}
      />

      <Modal
        title={t('settings.mcpDeleteServer')}
        visible={deleteConfirmVisible}
        onCancel={hideDeleteConfirm}
        onOk={handleConfirmDelete}
        okButtonProps={{ status: 'danger' }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        wrapClassName='eve-settings-dialog'
      >
        <p>{t('settings.mcpDeleteConfirm')}</p>
      </Modal>
    </SettingsSection>
  );
};

const ToolsModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [mcpMessage, mcpMessageContext] = Message.useMessage({ maxCount: 10 });
  const [imageGenerationModel, setImageGenerationModel] = useState<
    ConfigKeyMap['tools.imageGenerationModel'] | undefined
  >();
  const [speechToTextConfig, setSpeechToTextConfig] = useState<SpeechToTextConfig>(DEFAULT_SPEECH_TO_TEXT_CONFIG);
  const [isUpdatingImageGeneration, setIsUpdatingImageGeneration] = useState(false);
  const { modelListWithImage: data } = useConfigModelListWithImage();
  const { mcpServers, extensionMcpServers, saveMcpServers, setMcpServers, isMcpServersLoading } = useMcpServers();
  const builtinImageGenServer = useMemo(() => mcpServers.find(isBuiltinImageGenServer), [mcpServers]);
  const isImageGenerationServerLoading = isMcpServersLoading && !builtinImageGenServer;

  const imageGenerationModelList = useMemo(() => {
    if (!data) return [];
    return (data || [])
      .map((provider) =>
        Object.assign({}, provider, {
          models: provider.models.filter((modelName) => isImageGenSupported(provider, modelName)),
        })
      )
      .filter((provider) => provider.models.length > 0);
  }, [data]);

  useEffect(() => {
    const loadConfigs = async () => {
      try {
        await configService.whenReady();
        const storedModel = configService.get('tools.imageGenerationModel');
        const storedSpeechToTextConfig = configService.get('tools.speechToText');
        if (storedModel) {
          setImageGenerationModel(storedModel);
        }
        setSpeechToTextConfig(normalizeSpeechToTextConfig(storedSpeechToTextConfig));
      } catch (error) {
        setSpeechToTextConfig(failClosedSpeechToTextConfig());
        console.error('Failed to load tools config:', error);
      }
    };

    void loadConfigs();
  }, []);

  const updateSpeechToTextConfig = useCallback((updater: (current: SpeechToTextConfig) => SpeechToTextConfig) => {
    setSpeechToTextConfig((current) => {
      const next = normalizeSpeechToTextConfig(updater(current));
      configService.set('tools.speechToText', next).catch((error) => {
        console.error('Failed to save speech-to-text config:', error);
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT));
      }
      return next;
    });
  }, []);

  // Sync image generation model config to the built-in MCP server's transport.env
  const syncMcpServerEnv = useCallback(
    async (model: Partial<ConfigKeyMap['tools.imageGenerationModel']>) => {
      const builtinServer = mcpServers.find(isBuiltinImageGenServer);
      if (!builtinServer || builtinServer.transport.type !== 'stdio') return;

      const existingEnv = builtinServer.transport.env || {};
      let env: Record<string, string>;

      if (!model.id && !model.use_model) {
        env = removeImageGenerationEnvKeys(existingEnv);
        console.info('[ImageGen] Cleared built-in MCP image env because image generation model is unset');
      } else {
        const resolution = resolveImageGenerationMcpEnv(model, data || [], existingEnv);
        if (resolution.ok === false) {
          console.error('[ImageGen] Failed to resolve image MCP provider', {
            reason: resolution.reason,
            message: resolution.message,
            candidates: resolution.candidates,
          });
          throw new Error(resolution.message);
        }

        env = {
          ...removeImageGenerationEnvKeys(existingEnv),
          ...resolution.env,
        };
        console.info(
          '[ImageGen] Syncing built-in MCP image env via %s, provider id: %s, platform: %s, model: %s, api key present: %s',
          resolution.source,
          resolution.provider.id,
          resolution.provider.platform,
          resolution.model,
          resolution.provider.api_key ? 'yes' : 'no'
        );
      }

      if (areEnvRecordsEqual(existingEnv, env)) {
        return;
      }

      const updatedTransport = { ...builtinServer.transport, env };
      const original_json = JSON.stringify(
        {
          mcpServers: {
            [builtinServer.name]: {
              command: updatedTransport.command,
              args: updatedTransport.args || [],
              env,
            },
          },
        },
        null,
        2
      );

      const updatedServer = await mcpService.updateServer.invoke({
        id: builtinServer.id,
        data: {
          transport: updatedTransport,
          original_json,
        },
      });
      await saveMcpServers((prevServers) =>
        prevServers.map((server) => (server.id === updatedServer.id ? { ...server, ...updatedServer } : server))
      );
    },
    [data, mcpServers, saveMcpServers]
  );

  // Keep the saved image model as a provider/model reference. Secrets stay in providers.
  useEffect(() => {
    if (!imageGenerationModel || !data) return;

    const currentProvider = data.find((p) => p.id === imageGenerationModel.id);

    if (!currentProvider) {
      setImageGenerationModel(undefined);
      configService.remove('tools.imageGenerationModel').catch((error) => {
        console.error('Failed to remove image generation model config:', error);
      });
      void syncMcpServerEnv({}).catch((error) => {
        console.error('Failed to clear image generation MCP env after provider removal:', error);
      });
      return;
    }

    const sanitizedModel = {
      ...imageGenerationModel,
      name: currentProvider.name,
      platform: currentProvider.platform,
      base_url: '',
      api_key: '',
    };

    if (imageGenerationModel.api_key || imageGenerationModel.base_url) {
      setImageGenerationModel(sanitizedModel);
      configService.set('tools.imageGenerationModel', sanitizedModel).catch((error) => {
        console.error('Failed to sanitize image generation model config:', error);
      });
    }

    void syncMcpServerEnv(sanitizedModel).catch((error) => {
      console.error('Failed to sync image generation MCP env after provider change:', error);
    });
  }, [data, imageGenerationModel, syncMcpServerEnv]);

  const handleImageGenerationModelChange = useCallback(
    (value: Partial<ConfigKeyMap['tools.imageGenerationModel']>) => {
      setImageGenerationModel((prev) => {
        const newImageGenerationModel = {
          ...prev,
          id: value.id,
          name: value.name,
          platform: value.platform,
          base_url: '',
          api_key: '',
          use_model: value.use_model,
        } as ConfigKeyMap['tools.imageGenerationModel'];
        configService.set('tools.imageGenerationModel', newImageGenerationModel).catch((error) => {
          console.error('Failed to update image generation model config:', error);
        });
        // Sync env vars to the built-in MCP server
        void syncMcpServerEnv(newImageGenerationModel).catch((error) => {
          console.error('Failed to sync image generation MCP env:', error);
          mcpMessage.error(error instanceof Error ? error.message : t('settings.mcpSyncError'));
        });
        return newImageGenerationModel;
      });
    },
    [mcpMessage, syncMcpServerEnv, t]
  );

  const handleImageGenerationToggle = useCallback(
    async (checked: boolean) => {
      if (!builtinImageGenServer) return;

      setIsUpdatingImageGeneration(true);
      try {
        if (checked) {
          if (!imageGenerationModel?.id || !imageGenerationModel.use_model) {
            mcpMessage.error(t('settings.mcpSyncError'));
            return;
          }
          await syncMcpServerEnv(imageGenerationModel);
        }
        const updatedServer = await mcpService.toggleServer.invoke({
          id: builtinImageGenServer.id,
        });
        await saveMcpServers((prevServers) =>
          prevServers.map((server) => (server.id === updatedServer.id ? { ...server, ...updatedServer } : server))
        );

        if (updatedServer.enabled !== checked) {
          mcpMessage.error(checked ? t('settings.mcpSyncError') : t('settings.mcpRemoveError'));
          return;
        }

        setImageGenerationModel((prev) => {
          if (!prev) return prev;
          const next = { ...prev, switch: checked };
          configService.set('tools.imageGenerationModel', next).catch((error) => {
            console.error('Failed to sync image generation switch state:', error);
          });
          return next;
        });
      } catch (error) {
        console.error('Failed to toggle image generation MCP server:', error);
        mcpMessage.error(error instanceof Error ? error.message : t('settings.mcpSyncError'));
      } finally {
        setIsUpdatingImageGeneration(false);
      }
    },
    [builtinImageGenServer, imageGenerationModel, mcpMessage, saveMcpServers, syncMcpServerEnv, t]
  );

  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isImageGenerationModelUnavailable = !imageGenerationModelList.length || !imageGenerationModel?.use_model;

  return (
    <div className='eve-tools-settings flex flex-col h-full w-full'>
      {mcpMessageContext}

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <ModalMcpManagementSection
          message={mcpMessage}
          mcpServers={mcpServers}
          extensionMcpServers={extensionMcpServers}
          setMcpServers={setMcpServers}
          saveMcpServers={saveMcpServers}
          isPageMode={isPageMode}
        />

        <SettingsSection
          title={t('settings.imageGeneration')}
          description={t('settings.imageGenerationDescription')}
          action={
            <Switch
              disabled={
                isUpdatingImageGeneration ||
                isImageGenerationServerLoading ||
                !builtinImageGenServer ||
                (!builtinImageGenServer.enabled && isImageGenerationModelUnavailable)
              }
              checked={Boolean(builtinImageGenServer?.enabled) && !isImageGenerationServerLoading}
              loading={isImageGenerationServerLoading}
              onChange={handleImageGenerationToggle}
            />
          }
        >
          <Form layout='vertical' className='eve-settings-form'>
            <Form.Item
              label={t('settings.imageGenerationModel')}
              tooltip={
                COMMAND_EVE_SHELL_ENABLED ? (
                  t('settings.imageGenerationModelDescription')
                ) : (
                  <div className='space-y-4px'>
                    <div>{t('settings.imageGenSupportedTooltipTitle')}</div>
                    <ul className='list-disc pl-16px m-0'>
                      <li>{t('settings.imageGenSupportedTooltipGemini')}</li>
                      <li>{t('settings.imageGenSupportedTooltipOpenRouter')}</li>
                      <li>{t('settings.imageGenSupportedTooltipAntigravity')}</li>
                    </ul>
                    <div>{t('settings.imageGenUnsupportedTooltip')}</div>
                  </div>
                )
              }
            >
              {imageGenerationModelList.length > 0 ? (
                <AionSelect
                  value={
                    imageGenerationModel?.id && imageGenerationModel?.use_model
                      ? `${imageGenerationModel.id}|${imageGenerationModel.use_model}`
                      : undefined
                  }
                  onChange={(value) => {
                    const [platformId, modelName] = value.split('|');
                    const platform = imageGenerationModelList.find((p) => p.id === platformId);
                    if (platform) {
                      handleImageGenerationModelChange({
                        ...platform,
                        use_model: modelName,
                      });
                    }
                  }}
                >
                  {imageGenerationModelList.map(({ models, ...platform }) => (
                    <AionSelect.OptGroup label={platform.name} key={platform.id}>
                      {models.map((modelName) => (
                        <AionSelect.Option key={platform.id + modelName} value={platform.id + '|' + modelName}>
                          {modelName}
                        </AionSelect.Option>
                      ))}
                    </AionSelect.OptGroup>
                  ))}
                </AionSelect>
              ) : (
                <div className='eve-settings-inline-notice'>
                  {COMMAND_EVE_SHELL_ENABLED ? (
                    t('settings.imageGenerationUnavailable')
                  ) : (
                    <>
                      {t('settings.noAvailable')}
                      <Tooltip
                        content={
                          <div>
                            {t('settings.needHelpTooltip')}
                            <a
                              href='https://github.com/iOfficeAI/AionUi/wiki/AionUi-Image-Generation-Tool-Model-Configuration-Guide'
                              target='_blank'
                              rel='noopener noreferrer'
                              className='text-[rgb(var(--primary-6))] hover:text-[rgb(var(--primary-5))] underline ml-4px'
                              onClick={(e) => e.stopPropagation()}
                            >
                              {t('settings.configGuide')}
                            </a>
                          </div>
                        }
                      >
                        <a
                          href='https://github.com/iOfficeAI/AionUi/wiki/AionUi-Image-Generation-Tool-Model-Configuration-Guide'
                          target='_blank'
                          rel='noopener noreferrer'
                          className='ml-8px text-[rgb(var(--primary-6))] hover:text-[rgb(var(--primary-5))] cursor-pointer'
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Help theme='outline' size='14' />
                        </a>
                      </Tooltip>
                    </>
                  )}
                </div>
              )}
            </Form.Item>
          </Form>
        </SettingsSection>

        <SpeechToTextSettingsSection config={speechToTextConfig} onChange={updateSpeechToTextConfig} />
      </AionScrollArea>
    </div>
  );
};

export default ToolsModalContent;
