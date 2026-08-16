import { Badge } from '@arco-design/web-react';
import { CheckOne, Down, Right } from '@renderer/components/icons';
import React, { useState } from 'react';
import type { IMessagePlan } from '@/common/chat/chatLib';

const MessagePlan: React.FC<{ message: IMessagePlan }> = ({ message }) => {
  const [showMore, setShowMore] = useState(true);
  return (
    <div>
      <button
        type='button'
        className='flex items-center gap-10px p-0 border-none bg-transparent color-#86909C cursor-pointer font-inherit'
        onClick={() => setShowMore(!showMore)}
        aria-expanded={showMore}
      >
        <Badge status='default' text='To do list' className='![&_span.arco-badge-status-text]:text-t-secondary' />
        {showMore ? (
          <Down theme='outline' size={13} fill='currentColor' aria-hidden='true' />
        ) : (
          <Right theme='outline' size={13} fill='currentColor' aria-hidden='true' />
        )}
      </button>
      {showMore && (
        <div className='p-l-20px flex flex-col gap-8px pt-8px'>
          {message.content.entries.map((item, index) => {
            return (
              <div key={`${index}-${item.content}`} className='flex flex-row items-center text-t-secondary gap-8px'>
                {item.status === 'completed' ? (
                  <CheckOne theme='outline' size={22} strokeWidth={3} className='flex text-success-6' />
                ) : (
                  <div className='size-22px flex items-center justify-center'>
                    <div className='size-14px rd-10px b-2px b-solid border-[var(--eve-control-border,var(--color-border-2))]' />
                  </div>
                )}
                <span>{item.content} </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MessagePlan;
