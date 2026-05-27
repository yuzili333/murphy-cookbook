interface RecipeNameProps {
  name: string;
  pinyin?: string;
  as?: 'h1' | 'h2' | 'h3' | 'strong' | 'span';
  className?: string;
  showPronunciation?: boolean;
}

export function RecipeName({ name, pinyin = '', as = 'span', className = '', showPronunciation = true }: RecipeNameProps) {
  const Tag = as;
  const normalizedPinyin = pinyin.trim();

  if (!showPronunciation || !normalizedPinyin) {
    return <Tag className={`recipe-name ${className}`.trim()}>{name}</Tag>;
  }

  return (
    <Tag className={`recipe-name ${className}`.trim()}>
      <ruby className="recipe-ruby recipe-ruby-whole">
        {name}
        <rt>{normalizedPinyin}</rt>
      </ruby>
    </Tag>
  );
}
