import type { IProvider } from '@/common/config/storage';
import ModalHOC from '@/renderer/utils/ui/ModalHOC';
import { Form, Input, Message, Select, Tag } from '@arco-design/web-react';
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AionModal from '@/renderer/components/base/AionModal';
import { LinkCloud, Lock, Tips } from '@renderer/components/icons';
import { ipcBridge } from '@/common';
import useModeModeList from '@renderer/hooks/agent/useModeModeList';
import { getProviderLogo } from '@/renderer/utils/model/modelPlatforms';
import { scrubErrorText, scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';

/**
 * 供应商 Logo 组件
 * Provider Logo Component
 */
const ProviderLogo: React.FC<{ logo: string | null; name: string; size?: number }> = ({ logo, name, size = 20 }) => {
  if (logo) {
    return <img src={logo} alt={name} className='object-contain shrink-0' style={{ width: size, height: size }} />;
  }
  return <LinkCloud size={size} className='text-t-secondary flex shrink-0' />;
};

const EditModeModal = ModalHOC<{ data?: IProvider; onChange(data: IProvider): void; disabled?: boolean }>(
  ({ modalProps, modalCtrl, ...props }) => {
    const { t } = useTranslation();
    const { data } = props;
    const [form] = Form.useForm();
    const [message, messageContext] = Message.useMessage();

    // Watch bedrockAuthMethod only for UI conditional rendering (not for auto-refresh)
    const bedrockAuthMethod = Form.useWatch('bedrockAuthMethod', form);
    const isBedrock = data?.platform === 'bedrock';

    // 获取供应商 Logo / Get provider logo
    const providerLogo = useMemo(() => {
      return getProviderLogo({ name: data?.name, base_url: data?.base_url, platform: data?.platform });
    }, [data?.name, data?.base_url, data?.platform]);

    const isFullUrl = data?.is_full_url ?? false;

    // For Bedrock, don't pass bedrock_config to avoid auto-refresh on input changes
    // We'll build it dynamically in onFocus
    // When is_full_url, pass empty base_url to prevent auto-fetch with the full endpoint URL
    const modelListState = useModeModeList(
      data?.platform || 'gemini',
      isFullUrl ? '' : data?.base_url,
      isFullUrl ? '' : data?.api_key,
      true,
      undefined
    );

    useEffect(() => {
      if (data) {
        form.setFieldsValue({
          ...data,
          model:
            data.models && data.models.length > 0
              ? data.models.length === 1
                ? data.models[0]
                : data.models
              : undefined,
          bedrockAuthMethod: data.bedrock_config?.auth_method || 'accessKey',
          bedrockRegion: data.bedrock_config?.region || 'us-east-1',
          bedrockAccessKeyId: data.bedrock_config?.access_key_id || '',
          bedrockSecretAccessKey: data.bedrock_config?.secret_access_key || '',
          bedrockProfile: data.bedrock_config?.profile || '',
        });
      }
    }, [data, form]);

    return (
      <AionModal
        visible={modalProps.visible}
        onCancel={modalCtrl.close}
        header={{ title: t('settings.editModel'), showClose: true }}
        style={{ minHeight: '400px', maxHeight: '90vh', borderRadius: 16 }}
        contentStyle={{
          background: 'var(--dialog-fill-0)',
          borderRadius: 16,
          padding: '20px 24px 16px',
          overflow: 'auto',
        }}
        onOk={async () => {
          // 1.2.18 Req 4 — paid-seat gate: free/trial may not edit BYOK credentials
          // on an existing provider either. Block the save (defense-in-depth behind
          // the disabled api_key field below; the "Add Platform" button is the
          // primary gate in ModelModalContent).
          if (props.disabled) {
            modalCtrl.close();
            return;
          }
          try {
            const values = await form.validate();
            const updatedProvider: IProvider = {
              ...data,
              ...values,
              // Ensure models is always an array
              models: Array.isArray(values.model) ? values.model : [values.model],
            };

            // Add Bedrock configuration if platform is Bedrock
            if (isBedrock) {
              updatedProvider.bedrock_config = {
                auth_method: values.bedrockAuthMethod,
                region: values.bedrockRegion,
                ...(values.bedrockAuthMethod === 'accessKey'
                  ? {
                      access_key_id: values.bedrockAccessKeyId,
                      secret_access_key: values.bedrockSecretAccessKey,
                    }
                  : {
                      profile: values.bedrockProfile,
                    }),
              };
            }

            props.onChange(updatedProvider);
            modalCtrl.close();
          } catch {
            // Validation failed — Arco Form highlights invalid fields automatically
          }
        }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        {messageContext}
        <div className='py-20px'>
          <Form form={form} layout='vertical'>
            {/* 模型供应商名称（可编辑，带 Logo）/ Model Provider name (editable, with Logo) */}
            <Form.Item
              label={
                <div className='flex items-center gap-6px'>
                  <ProviderLogo logo={providerLogo} name={data?.name || ''} size={16} />
                  <span>{t('settings.modelProvider')}</span>
                </div>
              }
              field='name'
              required
              rules={[{ required: true }]}
            >
              <Input placeholder={t('settings.modelProvider')} />
            </Form.Item>

            {/* Base URL */}
            <Form.Item
              hidden={isBedrock}
              label={
                <span className='inline-flex items-center gap-4px'>
                  {t('settings.apiEndpoint', 'API 请求地址')}
                  {isFullUrl && (
                    <Tag size='small' color='arcoblue'>
                      {t('settings.fullUrl', '完整URL')}
                    </Tag>
                  )}
                </span>
              }
              required={data?.platform !== 'gemini' && data?.platform !== 'gemini-vertex-ai' && !isBedrock}
              rules={[{ required: data?.platform !== 'gemini' && data?.platform !== 'gemini-vertex-ai' && !isBedrock }]}
              field={'base_url'}
              disabled
            >
              <Input></Input>
            </Form.Item>

            <Form.Item
              hidden={isBedrock}
              label={t('settings.apiKey')}
              required={!isBedrock}
              rules={[{ required: !isBedrock }]}
              field={'api_key'}
              extra={
                <div className='mt-2 flex items-start gap-6px text-11px text-t-secondary'>
                  {/* The fallback MUST stay byte-identical to the one in
                      ModelModalContent and to the de-DE locale value for this key.
                      It used to read "nur im Pro-Tarif (99€/Monat)" — a plan that
                      never existed under that name, priced off the retired
                      per-client-seat ladder, and contradicting the canonical
                      translation of the SAME key. Two fallbacks for one key means
                      whichever surface loads first wins the price claim. */}
                  {props.disabled ? (
                    <>
                      <Lock className='mt-1px shrink-0' size={13} aria-hidden='true' />
                      <span>
                        {t(
                          'settings.byokPaidSeatOnly',
                          'Eigene Modelle / API-Keys sind im Standard-Abo enthalten (in der Testphase nicht freigeschaltet)'
                        )}
                      </span>
                    </>
                  ) : (
                    <>
                      <Tips className='mt-1px shrink-0' size={13} aria-hidden='true' />
                      <span>{t('settings.multiApiKeyEditTip')}</span>
                    </>
                  )}
                </div>
              }
            >
              <Input.TextArea rows={4} placeholder={t('settings.apiKeyPlaceholder')} disabled={props.disabled} />
            </Form.Item>

            {/* AWS Bedrock Authentication Method */}
            <Form.Item
              hidden={!isBedrock}
              label={t('settings.bedrock.authMethod')}
              field={'bedrockAuthMethod'}
              required={isBedrock}
              rules={[{ required: isBedrock }]}
            >
              <Select>
                <Select.Option value='accessKey'>{t('settings.bedrock.authMethodAccessKey')}</Select.Option>
                <Select.Option value='profile'>{t('settings.bedrock.authMethodProfile')}</Select.Option>
              </Select>
            </Form.Item>

            {/* AWS Region */}
            <Form.Item
              hidden={!isBedrock}
              label={t('settings.bedrock.region')}
              field={'bedrockRegion'}
              required={isBedrock}
              rules={[{ required: isBedrock }]}
              extra={t('settings.bedrock.regionHint')}
            >
              <Select showSearch>
                <Select.Option value='us-east-1'>US East (N. Virginia)</Select.Option>
                <Select.Option value='us-west-2'>US West (Oregon)</Select.Option>
                <Select.Option value='eu-west-1'>Europe (Ireland)</Select.Option>
                <Select.Option value='eu-central-1'>Europe (Frankfurt)</Select.Option>
                <Select.Option value='ap-southeast-1'>Asia Pacific (Singapore)</Select.Option>
                <Select.Option value='ap-northeast-1'>Asia Pacific (Tokyo)</Select.Option>
                <Select.Option value='ap-southeast-2'>Asia Pacific (Sydney)</Select.Option>
                <Select.Option value='ca-central-1'>Canada (Central)</Select.Option>
              </Select>
            </Form.Item>

            {/* Access Key ID */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'accessKey'}
              label={t('settings.bedrock.accessKeyId')}
              field={'bedrockAccessKeyId'}
              required={isBedrock && bedrockAuthMethod === 'accessKey'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'accessKey' }]}
            >
              <Input.Password placeholder='AKIA...' visibilityToggle />
            </Form.Item>

            {/* Secret Access Key */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'accessKey'}
              label={t('settings.bedrock.secretAccessKey')}
              field={'bedrockSecretAccessKey'}
              required={isBedrock && bedrockAuthMethod === 'accessKey'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'accessKey' }]}
            >
              <Input.Password visibilityToggle />
            </Form.Item>

            {/* AWS Profile */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'profile'}
              label={t('settings.bedrock.profile')}
              field={'bedrockProfile'}
              required={isBedrock && bedrockAuthMethod === 'profile'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'profile' }]}
              extra={t('settings.bedrock.profileHint')}
            >
              <Input placeholder='default' />
            </Form.Item>

            {/* Model Selection */}
            <Form.Item
              label={t('settings.modelName')}
              field={'model'}
              required
              rules={[{ required: true }]}
              validateStatus={!isFullUrl && modelListState.error ? 'error' : undefined}
              help={
                // The inline `help` is a RENDER SINK just as much as a toast: it
                // puts the raw provider error under the field, verbatim. Scrubbed
                // at the binding so a deny-listed slug cannot reach it either way.
                !isFullUrl && modelListState.error
                  ? scrubErrorText(modelListState.error, CLOUD_MODEL_IDENTIFIERS)
                  : undefined
              }
            >
              <Select
                loading={!isFullUrl && modelListState.isLoading}
                showSearch
                allowCreate
                mode={data?.models && data.models.length > 1 ? 'multiple' : undefined}
                onFocus={async () => {
                  if (isFullUrl) return;
                  // For Bedrock, build bedrock_config from current form values and fetch models
                  if (isBedrock) {
                    const values = form.getFields();
                    if (!values.bedrockAuthMethod || !values.bedrockRegion) {
                      message.error(t('settings.bedrock.fillRequiredFields'));
                      return;
                    }
                    if (
                      values.bedrockAuthMethod === 'accessKey' &&
                      (!values.bedrockAccessKeyId || !values.bedrockSecretAccessKey)
                    ) {
                      message.error(t('settings.bedrock.fillRequiredFields'));
                      return;
                    }
                    if (values.bedrockAuthMethod === 'profile' && !values.bedrockProfile) {
                      message.error(t('settings.bedrock.fillRequiredFields'));
                      return;
                    }
                    // Build bedrock_config and fetch models manually
                    const bedrock_config = {
                      auth_method: values.bedrockAuthMethod,
                      region: values.bedrockRegion,
                      ...(values.bedrockAuthMethod === 'accessKey'
                        ? {
                            access_key_id: values.bedrockAccessKeyId,
                            secret_access_key: values.bedrockSecretAccessKey,
                          }
                        : {
                            profile: values.bedrockProfile,
                          }),
                    };
                    try {
                      const res = await ipcBridge.mode.fetchModelList.invoke({
                        platform: data?.platform || 'bedrock',
                        api_key: '',
                        bedrock_config,
                      });
                      const models =
                        res.models.map((v) => {
                          if (typeof v === 'string') {
                            return { label: v, value: v };
                          } else {
                            return { label: v.name, value: v.id };
                          }
                        }) || [];
                      // Update the model list state manually
                      void modelListState.mutate({ models }, false);
                    } catch (error: any) {
                      // Scrubbed AT THE BINDING: a model-list fetch failure is
                      // exactly where the upstream names its own model.
                      message.error(
                        scrubModelIdentifiers(error.message || 'Failed to fetch models', CLOUD_MODEL_IDENTIFIERS)
                      );
                    }
                    return;
                  }
                  void modelListState.mutate();
                }}
                options={isFullUrl ? [] : modelListState.data?.models || []}
              />
            </Form.Item>
          </Form>
        </div>
      </AionModal>
    );
  }
);

export default EditModeModal;
