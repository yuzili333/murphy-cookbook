import type { CookingStep } from '../types';

interface StepCardProps {
  step: CookingStep;
  index: number;
  total: number;
  onSpeak?: (step: CookingStep) => void;
  activeSpeechKey?: string;
  embedded?: boolean;
}

function buildExpectedResult(step: CookingStep) {
  if (step.expectedResult?.trim()) {
    return step.expectedResult.trim();
  }

  if (step.title.includes('准备')) {
    return '食材摆放整齐，下一步可以直接动手。';
  }

  if (step.title.includes('切')) {
    return '食材大小接近，方便后面更快熟透。';
  }

  if (step.title.includes('煮') || step.title.includes('炒') || step.title.includes('蒸')) {
    return '食材变软、变香或颜色更明显时，就说明这一步差不多完成了。';
  }

  return '完成后先停一下，确认安全和口味，再进入下一步。';
}

export function StepCard({ step, index, total, onSpeak, activeSpeechKey = '', embedded = false }: StepCardProps) {
  const isSpeaking = activeSpeechKey === `step_${step.id}`;

  return (
    <section className={embedded ? 'step-card embedded-step-card' : 'step-card'}>
      <div className="step-meta">
        <span className="eyebrow">
          第 {index + 1} 步 / 共 {total} 步
        </span>
        <span className={`risk-pill risk-${step.riskLevel}`}>
          风险级别：{step.riskLevel}
        </span>
      </div>
      <div className="section-header">
        <h3>{step.title}</h3>
        {onSpeak ? (
          <button type="button" className="ghost-button" onClick={() => onSpeak(step)}>
            {isSpeaking ? '停止朗读' : '朗读这一步'}
          </button>
        ) : null}
      </div>
      <p>{step.description}</p>
      <div className="tip-card warm">
        <strong>孩子现在要做什么</strong>
        <p>{step.childAction?.trim() || step.description}</p>
      </div>
      <div className="tip-card compact-card">
        <strong>完成后应该看到什么</strong>
        <p>{buildExpectedResult(step)}</p>
      </div>
      <div className="tip-card">
        <strong>小贴士</strong>
        <p>{step.tip}</p>
      </div>
      {step.requiresParentAssist ? (
        <div className="alert-box">
          <strong>家长陪同</strong>
          <p>{step.parentAction?.trim() || '这一小步涉及热源或刀具，建议由家长陪同完成。'}</p>
        </div>
      ) : null}
    </section>
  );
}
