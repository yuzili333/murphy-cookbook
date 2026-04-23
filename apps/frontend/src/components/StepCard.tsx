import type { CookingStep } from '../types';

interface StepCardProps {
  step: CookingStep;
  index: number;
  total: number;
}

export function StepCard({ step, index, total }: StepCardProps) {
  return (
    <section className="step-card">
      <div className="step-meta">
        <span className="eyebrow">
          第 {index + 1} 步 / 共 {total} 步
        </span>
        <span className={`risk-pill risk-${step.riskLevel}`}>
          风险级别：{step.riskLevel}
        </span>
      </div>
      <h3>{step.title}</h3>
      <p>{step.description}</p>
      <div className="tip-card">
        <strong>小贴士</strong>
        <p>{step.tip}</p>
      </div>
      {step.requiresParentAssist ? (
        <div className="alert-box">
          <strong>家长陪同</strong>
          <p>这一小步涉及热源或刀具，建议由家长陪同完成。</p>
        </div>
      ) : null}
    </section>
  );
}
