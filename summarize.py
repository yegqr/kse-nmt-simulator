import pandas as pd, os

participants = pd.read_csv('/Users/yegqr/simulation-website-NMT/csv_export/participants.csv')
sessions     = pd.read_csv('/Users/yegqr/simulation-website-NMT/csv_export/exam_sessions.csv')
answers      = pd.read_csv('/Users/yegqr/simulation-website-NMT/csv_export/answers.csv')
questions    = pd.read_csv('/Users/yegqr/simulation-website-NMT/csv_export/questions.csv')

answers['answer_clean'] = answers['answer'].str.strip('"').str.strip("'")

df = (answers
    .merge(sessions[['id','participant_id','started_at','status','score_ukrainian','score_math']],
           left_on='session_id', right_on='id')
    .merge(participants[['id','full_name','seat_number']],
           left_on='participant_id', right_on='id', suffixes=('','_p'))
    .merge(questions[['id','subject','order_num','text','correct_answer']],
           left_on='question_id', right_on='id', suffixes=('','_q'))
)

df['is_correct'] = df['answer_clean'] == df['correct_answer']
df['started_at'] = pd.to_datetime(df['started_at'], unit='ms').dt.strftime('%Y-%m-%d %H:%M:%S')

df.sort_values(['full_name','session_id','order_num']).to_csv(
    'participant_answer_log.csv', index=False, encoding='utf-8-sig'
)
print("Done:", len(df), "rows")
