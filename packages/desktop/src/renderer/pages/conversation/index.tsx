import { ipcBridge } from '@/common';
import { Message, Spin } from '@arco-design/web-react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import ChatConversation from './components/ChatConversation';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

const ChatConversationIndex: React.FC = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hidePreview } = usePreviewContext();
  const { syncTitleFromHistory } = useAutoTitle();
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const notFoundHandledIdRef = useRef<string | undefined>(undefined);
  const defaultConversationTitle = t('conversation.welcome.newConversation');

  useEffect(() => {
    if (!id) return;

    // Hide the visible preview when conversations change, but retain each
    // conversation's tabs and dirty buffers so returning never loses work.
    if (previousConversationIdRef.current !== id) {
      hidePreview();
    }

    previousConversationIdRef.current = id;
  }, [id, hidePreview]);

  const { data, isLoading, mutate } = useSWR(id ? `conversation/${id}` : null, () => getConversationOrNull(id!), {
    // Keep the route-local ChatLayout mounted while another conversation is
    // resolved. Its workbench is deliberately hidden above, but Browser and
    // Terminal DOM/process state must not be destroyed by a one-frame loader.
    keepPreviousData: true,
  });

  useEffect(() => {
    if (!id) return;

    return ipcBridge.conversation.listChanged.on((event) => {
      if (event.conversation_id !== id || (event.action !== 'updated' && event.action !== 'created')) {
        return;
      }

      void mutate();
    });
  }, [id, mutate]);

  useEffect(() => {
    if (!data || data.name !== defaultConversationTitle) {
      return;
    }

    void syncTitleFromHistory(data.id);
  }, [data, defaultConversationTitle, syncTitleFromHistory]);

  // 会话不存在（例如从历史栈回到已删除会话）时，提示并替换路由到首页，
  // 避免渲染空骨架。每个 id 只触发一次。
  // Conversation does not exist (e.g. navigating back to a deleted one via
  // browser history): show a toast and replace the route with home, so we
  // don't render an empty skeleton. Fire at most once per id.
  useEffect(() => {
    if (!id || isLoading || data || notFoundHandledIdRef.current === id) return;
    notFoundHandledIdRef.current = id;
    Message.warning(t('conversation.notFound'));
    navigate('/', { replace: true });
  }, [id, isLoading, data, navigate, t]);

  if (isLoading && !data) return <Spin loading></Spin>;

  const isConversationTransition = Boolean(id && data && data.id !== id);
  return (
    <div className='relative size-full'>
      <div
        className='size-full'
        aria-hidden={isConversationTransition || undefined}
        style={isConversationTransition ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      >
        <ChatConversation conversation={data ?? undefined}></ChatConversation>
      </div>
      {isConversationTransition && (
        <div className='absolute inset-0 flex items-center justify-center' aria-live='polite'>
          <Spin loading />
        </div>
      )}
    </div>
  );
};

export default ChatConversationIndex;
