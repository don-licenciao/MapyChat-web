const UNDERAGE_LEX = /\b(menor(?:es)?|nin[oa]s?|adolescente(?:s)?|teen(?:ager)?s?|infante(?:s)?|pre(?:adolecente|pubescente)(?:s)?|loli|shota)\b/;
const UNDERAGE_AGE = /\b(1[0-7]|[1-9])\s*(años|anos|years?|yrs?|y\/o|yo)(\s*de\s*edad)?\b/;
const UNDERAGE_EXCLUSIONS = /\b(hace\s*\d+\s*anos|anos\s*(de\s*experiencia|despues|atras|antiguedad)|antiguedad\s*\d+\s*anos)\b/;
const HARD_RULES = /\b(incesto|zoofilia|bestialidad|violencia\s+sexual|violacion|rape|trata|explotacion|sextortion)\b/;
const DOXXING = /\b(dox(?:eo|ear|xing)|filtrar\s+datos|exponer\s+datos)\b/;
const REAL_LIKENESS = /(@\w+|https?:\/\/(www\.)?(instagram|facebook|tiktok|x|twitter)\.com\/\S+)/;
const NSFW_TERMS = /\b(sex|sexo|porn|porno|desnudo|desnudos|erot|fetich|xxx)\b/;

const isLetter = (char: string) => /[a-z]/.test(char);

const applyLeetspeak = (input: string) =>
  input.replace(/[1!30\$@]/g, (match, _group, offset) => {
    const prev = input[offset - 1] ?? '';
    const next = input[offset + 1] ?? '';
    const nearLetters = isLetter(prev) || isLetter(next);

    switch (match) {
      case '1':
      case '!':
        return nearLetters ? 'i' : match;
      case '3':
        return nearLetters ? 'e' : match;
      case '0':
        return nearLetters ? 'o' : match;
      case '$':
        return nearLetters ? 's' : match;
      case '@':
        return 'a';
      default:
        return match;
    }
  });

const normalizeText = (text: string) =>
  applyLeetspeak(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, ''),
  );

export function guardOrThrow(text: string): void {
  const normalized = normalizeText(text);

  if (UNDERAGE_LEX.test(normalized)) {
    throw new Error(
      'Lo siento, eso viola nuestras reglas de contenido seguro (referencia a menores).',
    );
  }

  if (UNDERAGE_AGE.test(normalized) && !UNDERAGE_EXCLUSIONS.test(normalized)) {
    throw new Error(
      'Lo siento, eso viola nuestras reglas de contenido seguro (referencia etaria a menores).',
    );
  }

  if (HARD_RULES.test(normalized)) {
    throw new Error(
      'Lo siento, eso viola nuestras reglas de contenido seguro (contenido hard prohibido).',
    );
  }

  if (DOXXING.test(normalized)) {
    throw new Error(
      'Lo siento, eso viola nuestras reglas de contenido seguro (doxxing).',
    );
  }

  const likenessInOriginalText = REAL_LIKENESS.test(text);
  if (likenessInOriginalText && NSFW_TERMS.test(normalized)) {
    throw new Error(
      'Lo siento, eso viola nuestras reglas de contenido seguro (likeness real en contexto NSFW).',
    );
  }
}
