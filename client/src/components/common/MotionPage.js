import { motion } from 'framer-motion'

export function MotionPage({ children, className }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} className={className}>
      {children}
    </motion.div>
  )
}
