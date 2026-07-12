import { Badge } from '@arco-design/web-react';
import { IconCheckCircle, IconDown, IconRight } from '@arco-design/web-react/icon';
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
        <Badge status='default' text='To do list' className={'![&_span.arco-badge-status-text]:color-#86909C'}></Badge>
        {showMore ? <IconDown /> : <IconRight />}
      </button>
      {showMore && (
        <div className='p-l-20px flex flex-col gap-8px pt-8px'>
          {message.content.entries.map((item, index) => {
            return (
              <div key={`${index}-${item.content}`} className='flex flex-row items-center color-#86909C gap-8px'>
                {item.status === 'completed' ? (
                  <IconCheckCircle fontSize={22} strokeWidth={4} className='flex color-#00B42A' />
                ) : (
                  <div className='size-22px flex items-center justify-center'>
                    <div className='size-14px  rd-10px b-2px b-solid b-[rgba(201,205,212,1)]'></div>
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
