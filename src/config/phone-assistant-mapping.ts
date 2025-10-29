export const PHONE_ASSISTANT_MAPPING = {
  '+17756182201': 'appraisee',
  '+16203372482': 'appraisee', // ramsample1@gmail.com
  '+12343015078': 'appraisee', // ramsample2@gmail.com
};

export const getAssistantTypeByPhoneNumber = (phoneNumber: string): string => {
  const assistantType = PHONE_ASSISTANT_MAPPING[phoneNumber];

  if (assistantType) {
    return assistantType;
  }

  console.log(`No mapping found for ${phoneNumber}, using default: ${process.env.ASSISTANT_TYPE || 'general'}`);
  return process.env.ASSISTANT_TYPE || 'general';
};
